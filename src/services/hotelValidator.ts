/**
 * Hotel record validation gate
 *
 * Two responsibilities:
 *  1. Coerce  – fix trivial type issues in-place (string→number, trim, truncate)
 *  2. Validate – surface real problems as errors (reject) or warnings (keep + log)
 *
 * Call `validateBatch()` on each batch before handing it to `insertHotels()`.
 */
import type { HotelRecord } from "./postgresService";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  field: string;
  severity: IssueSeverity;
  message: string;
}

export interface RecordValidationResult {
  /** false → record is rejected and will not be inserted */
  valid: boolean;
  issues: ValidationIssue[];
  /** The (potentially coerced) record to insert when valid */
  record: HotelRecord;
}

export interface BatchValidationResult {
  valid: HotelRecord[];
  rejected: RejectedRecord[];
  /** Records that passed but had warnings */
  warned: WarnedRecord[];
  stats: ValidationStats;
}

export interface RejectedRecord {
  raw: any;
  errors: ValidationIssue[];
}

export interface WarnedRecord {
  record: HotelRecord;
  warnings: ValidationIssue[];
}

export interface ValidationStats {
  total: number;
  passed: number;
  warned: number;
  rejected: number;
  issueBreakdown: Record<string, number>; // field → count of records with issues
}

// ─────────────────────────────────────────────────────────────────────────────
// Field length limits
// VARCHAR columns: limits match DDL exactly (DB will reject anything longer).
// TEXT columns:    limits are sanity caps only — PostgreSQL TEXT has no built-in
//                  limit, but absurdly long values waste storage & blow up logs.
// ─────────────────────────────────────────────────────────────────────────────

const LIMITS = {
  hotel_id:       200,  // VARCHAR(200)  in DDL
  name:          1000,  // TEXT          in DDL — sanity cap
  address:       2000,  // TEXT          in DDL — sanity cap
  postal_code:     20,  // VARCHAR(20)   in DDL
  phone:          100,  // VARCHAR(100)  in DDL
  email:          255,  // VARCHAR(255)  in DDL
  kind:            50,  // VARCHAR(50)   in DDL
  hotel_chain:   1000,  // TEXT          in DDL — sanity cap
  check_in_time:   20,  // VARCHAR(20)   in DDL
  check_out_time:  20,  // VARCHAR(20)   in DDL
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function err(issues: ValidationIssue[], field: string, msg: string): void {
  issues.push({ field, severity: "error", message: msg });
}

function warn(issues: ValidationIssue[], field: string, msg: string): void {
  issues.push({ field, severity: "warning", message: msg });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce value to number, returning undefined when it can't be done cleanly */
function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (isFinite(n)) return n;
  }
  return undefined;
}

/** Truncate a string to maxLen and warn if it was cut */
function truncate(
  issues: ValidationIssue[],
  field: string,
  value: string,
  maxLen: number,
): string {
  if (value.length <= maxLen) return value;
  warn(issues, field, `Truncated from ${value.length} to ${maxLen} chars`);
  return value.slice(0, maxLen);
}

const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;

// ─────────────────────────────────────────────────────────────────────────────
// Core validator
// ─────────────────────────────────────────────────────────────────────────────

export function validateHotel(raw: unknown): RecordValidationResult {
  const issues: ValidationIssue[] = [];

  // Must be a plain object at all
  if (!isPlainObject(raw)) {
    return {
      valid: false,
      issues: [{ field: "root", severity: "error", message: "Record is not an object" }],
      record: raw as any,
    };
  }

  // Work on a shallow copy so we don't mutate the caller's data
  const r: Record<string, any> = { ...raw };

  // ── id ──────────────────────────────────────────────────────────────────
  if (typeof r.id !== "string" || r.id.trim() === "") {
    err(issues, "id", `Missing or empty id (got ${JSON.stringify(r.id)})`);
  } else {
    r.id = r.id.trim();
    r.id = truncate(issues, "id", r.id, LIMITS.hotel_id);
  }

  // ── hid ─────────────────────────────────────────────────────────────────
  if (r.hid !== undefined && r.hid !== null) {
    const n = toNumber(r.hid);
    if (n === undefined || !Number.isInteger(n) || n <= 0) {
      warn(issues, "hid", `Expected positive integer, got ${JSON.stringify(r.hid)} — clearing`);
      r.hid = undefined;
    } else {
      r.hid = n;
    }
  }

  // ── name ────────────────────────────────────────────────────────────────
  if (r.name !== undefined && r.name !== null) {
    if (typeof r.name !== "string") {
      warn(issues, "name", `Expected string, got ${typeof r.name} — clearing`);
      r.name = null;
    } else {
      r.name = truncate(issues, "name", r.name.trim(), LIMITS.name);
    }
  }

  // ── coordinates ──────────────────────────────────────────────────────────
  const hasLat = r.latitude !== undefined && r.latitude !== null;
  const hasLng = r.longitude !== undefined && r.longitude !== null;

  if (hasLat !== hasLng) {
    warn(issues, "latitude/longitude", "Only one of latitude/longitude is present — clearing both");
    r.latitude = null;
    r.longitude = null;
  } else {
    if (hasLat) {
      const lat = toNumber(r.latitude);
      if (lat === undefined || lat < -90 || lat > 90) {
        warn(issues, "latitude", `Out of range [-90,90]: ${r.latitude} — clearing`);
        r.latitude = null;
        r.longitude = null;
      } else {
        r.latitude = lat;
      }
    }
    if (r.latitude !== null && hasLng) {
      const lng = toNumber(r.longitude);
      if (lng === undefined || lng < -180 || lng > 180) {
        warn(issues, "longitude", `Out of range [-180,180]: ${r.longitude} — clearing`);
        r.latitude = null;
        r.longitude = null;
      } else {
        r.longitude = lng;
      }
    }
  }

  // ── star_rating ──────────────────────────────────────────────────────────
  if (r.star_rating !== undefined && r.star_rating !== null) {
    const sr = toNumber(r.star_rating);
    if (sr === undefined || sr < 0 || sr > 5) {
      warn(issues, "star_rating", `Out of range [0,5]: ${r.star_rating} — clearing`);
      r.star_rating = null;
    } else {
      r.star_rating = sr;
    }
  }

  // ── string scalars ────────────────────────────────────────────────────────
  for (const [field, maxLen] of Object.entries(LIMITS) as [keyof typeof LIMITS, number][]) {
    if (field === "hotel_id" || field === "name") continue; // already handled
    const v = r[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") {
      warn(issues, field, `Expected string, got ${typeof v} — coercing`);
      r[field] = String(v).slice(0, maxLen);
    } else {
      r[field] = truncate(issues, field, v.trim(), maxLen);
    }
  }

  // ── time format check ─────────────────────────────────────────────────────
  for (const field of ["check_in_time", "check_out_time", "check_in_time_end",
                        "front_desk_time_start", "front_desk_time_end"] as const) {
    const v = r[field];
    if (v != null && typeof v === "string" && v.trim() !== "" && !TIME_RE.test(v.trim())) {
      warn(issues, field, `Unexpected time format: "${v}" — keeping as-is`);
    }
  }

  // ── boolean flags ─────────────────────────────────────────────────────────
  for (const field of ["is_closed", "deleted", "is_gender_specification_required"] as const) {
    if (r[field] === undefined || r[field] === null) {
      r[field] = false; // default
    } else if (typeof r[field] !== "boolean") {
      warn(issues, field, `Expected boolean, got ${typeof r[field]} — coercing to false`);
      r[field] = false;
    }
  }

  // ── region ───────────────────────────────────────────────────────────────
  if (r.region !== undefined && r.region !== null) {
    if (!isPlainObject(r.region)) {
      warn(issues, "region", `Expected object, got ${typeof r.region} — clearing`);
      r.region = undefined;
    } else {
      const rid = toNumber(r.region.id);
      if (rid === undefined || !Number.isInteger(rid) || rid <= 0) {
        warn(issues, "region.id", `Expected positive integer, got ${JSON.stringify(r.region.id)} — clearing region`);
        r.region = undefined;
      }
    }
  }

  // ── images ────────────────────────────────────────────────────────────────
  if (r.images !== undefined && r.images !== null) {
    if (!Array.isArray(r.images)) {
      warn(issues, "images", `Expected array, got ${typeof r.images} — clearing`);
      r.images = [];
    } else {
      const before = r.images.length;
      r.images = r.images.filter((u: unknown) => typeof u === "string" && u.trim() !== "");
      if (r.images.length !== before) {
        warn(issues, "images", `Removed ${before - r.images.length} non-string image entries`);
      }
    }
  }

  // ── images_ext ────────────────────────────────────────────────────────────
  if (r.images_ext !== undefined && r.images_ext !== null) {
    if (!Array.isArray(r.images_ext)) {
      warn(issues, "images_ext", `Expected array, got ${typeof r.images_ext} — clearing`);
      r.images_ext = [];
    } else {
      const before = r.images_ext.length;
      r.images_ext = r.images_ext.filter(
        (e: unknown) => isPlainObject(e) && typeof e.url === "string",
      );
      if (r.images_ext.length !== before) {
        warn(issues, "images_ext", `Removed ${before - r.images_ext.length} invalid images_ext entries`);
      }
    }
  }

  // ── amenity_groups ────────────────────────────────────────────────────────
  if (r.amenity_groups !== undefined && r.amenity_groups !== null) {
    if (!Array.isArray(r.amenity_groups)) {
      warn(issues, "amenity_groups", `Expected array, got ${typeof r.amenity_groups} — clearing`);
      r.amenity_groups = [];
    } else {
      const before = r.amenity_groups.length;
      r.amenity_groups = r.amenity_groups.filter(
        (g: unknown) => isPlainObject(g) && typeof g.group_name === "string",
      );
      if (r.amenity_groups.length !== before) {
        warn(issues, "amenity_groups", `Removed ${before - r.amenity_groups.length} invalid groups`);
      }
      // Ensure amenities and non_free_amenities are string arrays
      for (const g of r.amenity_groups) {
        for (const key of ["amenities", "non_free_amenities"] as const) {
          if (!Array.isArray(g[key])) g[key] = [];
          g[key] = (g[key] as unknown[]).filter((a: unknown) => typeof a === "string");
        }
      }
    }
  }

  // ── description_struct / policy_struct ────────────────────────────────────
  for (const field of ["description_struct", "policy_struct"] as const) {
    const v = r[field];
    if (v !== undefined && v !== null) {
      if (!Array.isArray(v)) {
        warn(issues, field, `Expected array, got ${typeof v} — clearing`);
        r[field] = [];
      } else {
        const before = v.length;
        r[field] = v.filter(
          (s: unknown) =>
            isPlainObject(s) &&
            (typeof s.title === "string" || s.title == null) &&
            Array.isArray(s.paragraphs),
        );
        if (r[field].length !== before) {
          warn(issues, field, `Removed ${before - r[field].length} malformed sections`);
        }
      }
    }
  }

  // ── room_groups ───────────────────────────────────────────────────────────
  if (r.room_groups !== undefined && r.room_groups !== null) {
    if (!Array.isArray(r.room_groups)) {
      warn(issues, "room_groups", `Expected array, got ${typeof r.room_groups} — clearing`);
      r.room_groups = [];
    }
  }

  // ── serp_filters ──────────────────────────────────────────────────────────
  if (r.serp_filters !== undefined && r.serp_filters !== null) {
    if (!Array.isArray(r.serp_filters)) {
      warn(issues, "serp_filters", `Expected array, got ${typeof r.serp_filters} — clearing`);
      r.serp_filters = [];
    } else {
      r.serp_filters = r.serp_filters.filter((f: unknown) => typeof f === "string");
    }
  }

  // ── Determine validity ────────────────────────────────────────────────────
  const hasErrors = issues.some((i) => i.severity === "error");

  return {
    valid: !hasErrors,
    issues,
    record: r as HotelRecord,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch validation
// ─────────────────────────────────────────────────────────────────────────────

export function validateBatch(batch: unknown[]): BatchValidationResult {
  const valid: HotelRecord[] = [];
  const rejected: RejectedRecord[] = [];
  const warned: WarnedRecord[] = [];
  const issueBreakdown: Record<string, number> = {};
  const seenIds = new Set<string>();

  for (const raw of batch) {
    const result = validateHotel(raw);

    // Track issue fields for breakdown
    for (const issue of result.issues) {
      issueBreakdown[issue.field] = (issueBreakdown[issue.field] ?? 0) + 1;
    }

    if (!result.valid) {
      rejected.push({ raw, errors: result.issues.filter((i) => i.severity === "error") });
      continue;
    }

    // Deduplicate within batch (second occurrence loses)
    const hotelId = result.record.id;
    if (seenIds.has(hotelId)) {
      rejected.push({
        raw,
        errors: [{ field: "id", severity: "error", message: `Duplicate hotel_id in batch: ${hotelId}` }],
      });
      continue;
    }
    seenIds.add(hotelId);

    const hasWarnings = result.issues.some((i) => i.severity === "warning");
    if (hasWarnings) {
      warned.push({ record: result.record, warnings: result.issues.filter((i) => i.severity === "warning") });
    }

    valid.push(result.record);
  }

  return {
    valid,
    rejected,
    warned,
    stats: {
      total: batch.length,
      passed: valid.length,
      warned: warned.length,
      rejected: rejected.length,
      issueBreakdown,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rejection writer  (appends JSONL, safe to call from multiple batches)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";

export interface RejectionLogOptions {
  /** Directory to write rejection files (default: ./downloads) */
  dir?: string;
  /** File stem; a .jsonl extension is appended (default: rejected_<ISO-date>) */
  fileStem?: string;
}

let _rejectionStream: fs.WriteStream | null = null;
let _rejectionPath: string | null = null;

export function getRejectionLogPath(): string | null {
  return _rejectionPath;
}

export function writeRejections(
  rejected: RejectedRecord[],
  opts: RejectionLogOptions = {},
): void {
  if (rejected.length === 0) return;

  const dir = opts.dir ?? "./downloads";
  fs.mkdirSync(dir, { recursive: true });

  if (!_rejectionStream) {
    const stem = opts.fileStem ?? `rejected_${new Date().toISOString().slice(0, 10)}`;
    _rejectionPath = path.join(dir, `${stem}.jsonl`);
    _rejectionStream = fs.createWriteStream(_rejectionPath, { flags: "a" });
    console.warn(`  ⚠ Writing rejected records to: ${_rejectionPath}`);
  }

  for (const r of rejected) {
    const line = JSON.stringify({ record: r.raw, errors: r.errors });
    _rejectionStream.write(line + "\n");
  }
}

export function closeRejectionLog(): void {
  if (_rejectionStream) {
    _rejectionStream.end();
    _rejectionStream = null;
  }
}
