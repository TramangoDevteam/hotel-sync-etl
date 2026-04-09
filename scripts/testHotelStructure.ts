/**
 * Runtime hotel structure inspector
 *
 * Fetches the dump URL → streams download → decompresses on the fly →
 * reads first N records → prints actual JSON structure + field analysis.
 *
 * Run: npx ts-node src/testHotelStructure.ts [numberOfRecords]
 */
import "dotenv/config";
import https from "https";
import type { IncomingMessage } from "http";
import { spawn } from "child_process";
import { createInterface } from "readline";
import axios from "axios";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const KEY_ID = (process.env.KEY_ID ?? "").trim();
const API_KEY = (process.env.API_KEY ?? "").trim().replace(/^"|"$/g, ""); // strip stray quotes
const SAMPLE = parseInt(process.argv[2] ?? "3", 10);

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 – get the presigned dump URL
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDumpUrl(): Promise<string> {
  console.log(`\nFetching dump URL  (keyId=${KEY_ID})...`);
  const res = await axios.post<any>(
    "https://api.worldota.net/api/b2b/v3/hotel/info/dump/",
    { inventory: "all", language: "en" },
    {
      auth: { username: KEY_ID, password: API_KEY },
      headers: { "Content-Type": "application/json" },
      timeout: 30_000,
    },
  );

  const url: string | undefined = res.data?.data?.url;
  if (!url) {
    throw new Error(
      `No dump URL in response:\n${JSON.stringify(res.data, null, 2)}`,
    );
  }
  console.log(`✓ Got dump URL (last_update: ${res.data?.data?.last_update})`);
  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 – stream download → zstd decompress → read N JSON lines
// ─────────────────────────────────────────────────────────────────────────────

async function streamFirstRecords(
  dumpUrl: string,
  count: number,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const records: any[] = [];
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      rl.close();
      try { zstd.kill("SIGTERM"); } catch {}
      try { httpRes?.destroy(); } catch {}
      resolve(records);
    }

    // Spawn zstd reading from stdin, writing decompressed to stdout
    const zstd = spawn("zstd", ["-d", "--stdout", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    zstd.on("error", (err) => {
      if (!done) reject(new Error(`zstd error: ${err.message}`));
    });

    zstd.stderr.on("data", (d: Buffer) => {
      // zstd status messages go to stderr; log non-empty ones
      const msg = d.toString().trim();
      if (msg && !msg.startsWith("/*")) {
        // suppress normal progress frames
      }
    });

    // Parse lines from decompressed stdout
    const rl = createInterface({ input: zstd.stdout, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
      if (done) return;
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) return;
      try {
        const record = JSON.parse(trimmed);
        records.push(record);
        process.stdout.write(`  parsed record #${records.length}\r`);
        if (records.length >= count) finish();
      } catch {
        // skip malformed JSON lines
      }
    });

    rl.on("close", () => {
      if (!done) finish(); // stream ended before we got `count` records
    });

    // Start the HTTP download and pipe into zstd stdin
    let httpRes: IncomingMessage | null = null;

    console.log("Streaming download → zstd decompress...");
    const req = https.get(dumpUrl, (res) => {
      httpRes = res;
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from dump URL`));
        res.destroy();
        return;
      }
      res.pipe(zstd.stdin, { end: true });
      res.on("error", (err) => {
        if (!done) reject(err);
      });
    });

    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 – analyse and print the structure
// ─────────────────────────────────────────────────────────────────────────────

type FieldInfo = {
  types: Set<string>;
  nullable: boolean;
  seen: number;
  example: any;
  children?: Record<string, FieldInfo>;
  itemSample?: any;
};

function detectType(v: any): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function merge(existing: FieldInfo | undefined, value: any, total: number): FieldInfo {
  const t = detectType(value);
  if (!existing) {
    const fi: FieldInfo = {
      types: new Set([t]),
      nullable: t === "null",
      seen: 1,
      example: value,
    };
    if (t === "object" && value !== null) {
      fi.children = {};
      for (const [k, v] of Object.entries(value)) {
        fi.children[k] = merge(undefined, v, 1);
      }
    }
    if (t === "array" && (value as any[]).length > 0) {
      fi.itemSample = (value as any[])[0];
    }
    return fi;
  }

  existing.types.add(t);
  if (t === "null") existing.nullable = true;
  existing.seen++;
  if (existing.example === null && value !== null) existing.example = value;

  if (t === "object" && value !== null) {
    if (!existing.children) existing.children = {};
    for (const [k, v] of Object.entries(value)) {
      existing.children[k] = merge(existing.children[k], v, existing.seen);
    }
  }
  if (t === "array" && !existing.itemSample && (value as any[]).length > 0) {
    existing.itemSample = (value as any[])[0];
  }
  return existing;
}

function buildSchema(records: any[]): Record<string, FieldInfo> {
  const schema: Record<string, FieldInfo> = {};
  for (const record of records) {
    // Mark missing keys as nullable
    for (const k of Object.keys(schema)) {
      if (!(k in record)) schema[k].nullable = true;
    }
    for (const [k, v] of Object.entries(record)) {
      schema[k] = merge(schema[k], v, records.length);
    }
  }
  return schema;
}

function printField(name: string, info: FieldInfo, indent = 0, total = 1): void {
  const pad = "  ".repeat(indent);
  const types = [...info.types].join(" | ");
  const coverage = `${((info.seen / total) * 100).toFixed(0)}%`;
  const nullable = info.nullable ? "?" : " ";

  let exStr = "";
  if (info.example !== null && info.example !== undefined) {
    const raw = JSON.stringify(info.example);
    exStr = raw.length > 120 ? raw.slice(0, 120) + "…" : raw;
  }

  console.log(`${pad}${nullable} ${name}: ${types}  [${coverage} of records]`);
  if (exStr) console.log(`${pad}    example: ${exStr}`);

  if (info.children) {
    for (const [k, v] of Object.entries(info.children)) {
      printField(k, v, indent + 1, info.seen);
    }
  }

  if (info.itemSample !== null && info.itemSample !== undefined) {
    const itemType = detectType(info.itemSample);
    if (itemType === "object") {
      console.log(`${pad}  [array item shape]:`);
      for (const [k, v] of Object.entries(info.itemSample as object)) {
        const fi: FieldInfo = { types: new Set([detectType(v)]), nullable: false, seen: 1, example: v };
        printField(k, fi, indent + 2, 1);
      }
    } else {
      console.log(`${pad}  [array of ${itemType}]`);
    }
  }
}

function printCurrentMappingCheck(schema: Record<string, FieldInfo>): void {
  // These are the fields the current postgresService.insertHotels() reads
  const currentMappings = [
    { dbCol: "hotel_id",        fromFields: ["id", "hotel_id"] },
    { dbCol: "name",            fromFields: ["name"] },
    { dbCol: "description",     fromFields: ["description"] },
    { dbCol: "country",         fromFields: ["country"] },
    { dbCol: "state",           fromFields: ["state"] },
    { dbCol: "city",            fromFields: ["city"] },
    { dbCol: "zip_code",        fromFields: ["zip_code"] },
    { dbCol: "address",         fromFields: ["address"] },
    { dbCol: "latitude",        fromFields: ["latitude"] },
    { dbCol: "longitude",       fromFields: ["longitude"] },
    { dbCol: "star_rating",     fromFields: ["star_rating"] },
    { dbCol: "phone",           fromFields: ["phone"] },
    { dbCol: "fax",             fromFields: ["fax"] },
    { dbCol: "website",         fromFields: ["website"] },
    { dbCol: "email",           fromFields: ["email"] },
    { dbCol: "check_in_time",   fromFields: ["check_in_time"] },
    { dbCol: "check_out_time",  fromFields: ["check_out_time"] },
    { dbCol: "images",          fromFields: ["images"] },
    { dbCol: "amenities",       fromFields: ["amenities"] },
    { dbCol: "languages",       fromFields: ["languages"] },
  ];

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║         Current DB Mapping vs Actual API Fields      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  let mismatches = 0;
  for (const m of currentMappings) {
    const found = m.fromFields.find((f) => f in schema);
    if (found) {
      const info = schema[found];
      const types = [...info.types].join("|");
      const icon = types.includes("object") ? "⚠ OBJECT (not scalar)" :
                   types.includes("array")  ? "⚠ ARRAY (may need flattening)" : "✓";
      console.log(`  ${icon}  ${m.dbCol} ← record.${found}  [${types}]`);
      if (types.includes("object") || types.includes("array")) {
        const ex = JSON.stringify(info.example)?.slice(0, 100);
        console.log(`       example: ${ex}`);
        mismatches++;
      }
    } else {
      console.log(`  ✗ MISSING  ${m.dbCol} — none of [${m.fromFields.join(", ")}] exist in real data`);
      mismatches++;
    }
  }

  console.log(`\n  ${mismatches === 0 ? "✓ All mappings look correct!" : `⚠ ${mismatches} field(s) need attention`}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!KEY_ID || !API_KEY) {
    console.error("✗ KEY_ID and API_KEY must be set in .env");
    process.exit(1);
  }

  try {
    const dumpUrl = await fetchDumpUrl();

    console.log(`\nStreaming first ${SAMPLE} hotel record(s) from dump...`);
    const records = await streamFirstRecords(dumpUrl, SAMPLE);
    console.log(`\n✓ Got ${records.length} records\n`);

    if (records.length === 0) {
      console.error("No records parsed — check zstd is installed (brew install zstd)");
      process.exit(1);
    }

    // ── Raw JSON of first record ───────────────────────────────────────────
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              First Raw Hotel Record                  ║");
    console.log("╚══════════════════════════════════════════════════════╝\n");
    console.log(JSON.stringify(records[0], null, 2));

    // ── Schema analysis ────────────────────────────────────────────────────
    const schema = buildSchema(records);
    const total = records.length;

    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log(`║      Field Schema  (${total} record sample)              ║`);
    console.log("╚══════════════════════════════════════════════════════╝\n");
    console.log("  Legend:  ? = nullable/missing in some records\n");

    for (const [field, info] of Object.entries(schema)) {
      printField(field, info, 0, total);
    }

    // ── Mapping check ──────────────────────────────────────────────────────
    printCurrentMappingCheck(schema);

    // ── Top-level keys summary ─────────────────────────────────────────────
    console.log("Top-level keys found:");
    console.log(" ", Object.keys(schema).sort().join(", "));
    console.log("");
  } catch (err: any) {
    console.error("\n✗ Failed:", err.message ?? err);
    if (err.response) {
      console.error("  API response:", JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
