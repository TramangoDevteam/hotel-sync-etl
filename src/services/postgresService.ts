import * as fs from "fs";
import * as path from "path";
import { Pool, PoolClient } from "pg";
import {
  validateBatch,
  writeRejections,
  closeRejectionLog,
  type RejectionLogOptions,
} from "./hotelValidator";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Raw hotel record as it arrives from the WorldOTA API dump */
export interface HotelRecord {
  id: string;           // string slug, e.g. "welcome_perm"
  hid?: number;         // numeric hotel ID
  name?: string;
  kind?: string;        // "Hotel", "Hostel", …
  address?: string;
  postal_code?: string;
  latitude?: number;
  longitude?: number;
  star_rating?: number;
  phone?: string;
  email?: string | null;
  check_in_time?: string;
  check_out_time?: string;
  check_in_time_end?: string | null;
  front_desk_time_start?: string | null;
  front_desk_time_end?: string | null;
  hotel_chain?: string;
  is_closed?: boolean;
  deleted?: boolean;
  is_gender_specification_required?: boolean;
  star_certificate?: string | null;
  metapolicy_extra_info?: string;
  serp_filters?: string[];
  facts?: Record<string, any>;
  keys_pickup?: Record<string, any>;
  metapolicy_struct?: Record<string, any>;
  payment_methods?: any[];

  /** Nested region object */
  region?: {
    id: number;
    country_code?: string;
    iata?: string;
    name?: string;
    type?: string;
  };

  /** Image URL strings with {size} placeholder */
  images?: string[];

  /** Extended image info */
  images_ext?: Array<{ url: string; category_slug?: string }>;

  /** Amenity groups */
  amenity_groups?: Array<{
    group_name: string;
    amenities: string[];
    non_free_amenities: string[];
  }>;

  /** Description sections */
  description_struct?: Array<{ title: string; paragraphs: string[] }>;

  /** Policy sections */
  policy_struct?: Array<{ title: string; paragraphs: string[] }>;

  /** Room groups */
  room_groups?: Array<{
    room_group_id?: number;
    name?: string;
    name_struct?: Record<string, any>;
    rg_ext?: Record<string, any>;
    room_amenities?: string[];
    images?: string[];
    images_ext?: Array<{ url: string; category_slug?: string }>;
  }>;

  [key: string]: any; // allow unknown future fields
}

export interface PostgresConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  ssl?:
    | boolean
    | {
        rejectUnauthorized?: boolean;
        ca?: string;
        key?: string;
        cert?: string;
      };
}

export interface InsertStats {
  totalRecords: number;
  successfulInserts: number;
  failedInserts: number;
  /** Records rejected by the validation gate before any DB attempt */
  rejectedByValidation: number;
  /** Records that passed but had coercion warnings */
  validationWarnings: number;
  insertTimeMs: number;
}

export interface InsertOptions {
  upsert?: boolean;
  batchSize?: number;
  /**
   * Run the validation gate before inserting.
   * - `true`  → validate + reject bad records + log to console
   * - `false` → skip validation entirely (fastest, less safe)
   * default: true
   */
  validate?: boolean;
  /**
   * When validation is enabled, write rejected records to a JSONL file
   * so you can inspect and replay them later.
   */
  rejectionLog?: RejectionLogOptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

class PostgresService {
  private pool: Pool;

  constructor(config: PostgresConfig) {
    if (!config.host || !config.database || !config.user) {
      throw new Error(
        "PostgreSQL config requires host, database, and user",
      );
    }

    const poolConfig: any = {
      host: config.host,
      port: config.port ?? 5432,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.maxConnections ?? 20,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 2_000,
    };

    if (config.ssl) {
      poolConfig.ssl =
        typeof config.ssl === "boolean"
          ? { rejectUnauthorized: false }
          : config.ssl;
    }

    this.pool = new Pool(poolConfig);
    this.pool.on("error", (err) =>
      console.error("Unexpected error in PostgreSQL pool:", err),
    );
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async testConnection(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query("SELECT NOW()");
      console.log(`✓ PostgreSQL connection OK: ${result.rows[0].now}`);
    } finally {
      client.release();
    }
  }

  // ── Schema creation ───────────────────────────────────────────────────────

  /**
   * Apply the full relational schema from the SQL migration file.
   * Idempotent – uses CREATE TABLE IF NOT EXISTS throughout.
   */
  async createSchema(): Promise<void> {
    const migrationPath = path.join(
      __dirname,
      "../migrations/001_hotel_schema.sql",
    );

    let sql: string;
    try {
      sql = fs.readFileSync(migrationPath, "utf8");
    } catch {
      // Fallback: inline DDL if file not found (e.g. compiled dist layout)
      sql = this.inlineDDL();
    }

    const client = await this.pool.connect();
    try {
      await client.query(sql);
      console.log("✓ Schema ready (hotel_regions, hotels, hotel_images, hotel_amenity_groups, hotel_amenities, hotel_content_sections, hotel_room_groups)");
    } catch (err) {
      throw new Error(
        `Failed to create schema: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      client.release();
    }
  }

  /** Legacy alias kept for backwards compatibility */
  async createHotelsTable(): Promise<void> {
    return this.createSchema();
  }

  // ── Insert ────────────────────────────────────────────────────────────────

  /**
   * Upsert a batch of hotel records into the full relational schema.
   * By default runs the validation gate and rejects malformed records.
   */
  async insertHotels(
    records: HotelRecord[],
    options: InsertOptions = {},
  ): Promise<InsertStats> {
    const startTime = Date.now();
    const { batchSize = 100, validate = true, rejectionLog } = options;

    let successfulInserts = 0;
    let failedInserts = 0;
    let rejectedByValidation = 0;
    let validationWarnings = 0;

    // ── Validation gate ────────────────────────────────────────────────────
    let toInsert: HotelRecord[] = records;
    if (validate && records.length > 0) {
      const vr = validateBatch(records as unknown[]);

      rejectedByValidation = vr.rejected.length;
      validationWarnings   = vr.warned.length;

      if (rejectedByValidation > 0) {
        console.warn(
          `⚠ Validation gate: ${rejectedByValidation}/${records.length} records rejected`,
        );
        // Sample the first 3 rejection reasons for visibility
        for (const r of vr.rejected.slice(0, 3)) {
          const id = (r.raw as any)?.id ?? "(no id)";
          const msgs = r.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
          console.warn(`  ✗ [${id}] ${msgs}`);
        }
        if (rejectedByValidation > 3) {
          console.warn(`  … and ${rejectedByValidation - 3} more`);
        }
        writeRejections(vr.rejected, rejectionLog);
      }

      if (validationWarnings > 0) {
        console.warn(`⚠ Validation gate: ${validationWarnings} records coerced (warnings only)`);
      }

      toInsert = vr.valid;
    }

    // Process in sub-batches
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      const client = await this.pool.connect();

      try {
        await client.query("BEGIN");

        // Use a savepoint per hotel so one failure doesn't poison the whole
        // batch transaction (a plain catch after a DB error leaves the txn in
        // an aborted state, causing every subsequent statement to fail too).
        for (const record of batch) {
          try {
            await client.query("SAVEPOINT hotel_sp");
            await this.upsertOne(client, record);
            await client.query("RELEASE SAVEPOINT hotel_sp");
            successfulInserts++;
          } catch (err) {
            await client.query("ROLLBACK TO SAVEPOINT hotel_sp");
            await client.query("RELEASE SAVEPOINT hotel_sp");
            console.error(
              `✗ Failed to upsert hotel ${record.id}:`,
              err instanceof Error ? err.message : err,
            );
            failedInserts++;
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(
          `✗ Batch ${i}–${i + batch.length} rolled back:`,
          err instanceof Error ? err.message : err,
        );
        failedInserts += batch.length;
      } finally {
        client.release();
      }

      if ((i + batchSize) % 500 === 0) {
        console.log(`  Inserted: ${successfulInserts} records`);
      }
    }

    console.log(`✓ Insert complete: ${successfulInserts} ok, ${failedInserts} failed, ${rejectedByValidation} rejected by validation`);
    return {
      totalRecords: records.length,
      successfulInserts,
      failedInserts,
      rejectedByValidation,
      validationWarnings,
      insertTimeMs: Date.now() - startTime,
    };
  }

  // ── Core upsert for a single hotel ───────────────────────────────────────

  private async upsertOne(client: PoolClient, r: HotelRecord): Promise<void> {
    // 1. Region
    let regionInternalId: number | null = null;
    if (r.region?.id != null) {
      const regionRes = await client.query<{ id: number }>(
        `INSERT INTO hotel_regions (region_id, country_code, iata, name, type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (region_id) DO UPDATE SET
           country_code = EXCLUDED.country_code,
           iata         = EXCLUDED.iata,
           name         = EXCLUDED.name,
           type         = EXCLUDED.type
         RETURNING id`,
        [
          r.region.id,
          r.region.country_code ?? null,
          r.region.iata ?? null,
          r.region.name ?? null,
          r.region.type ?? null,
        ],
      );
      regionInternalId = regionRes.rows[0].id;
    }

    // 2. Hotel core
    const hotelRes = await client.query<{ id: number }>(
      `INSERT INTO hotels (
         hotel_id, hid, name, kind, address, postal_code,
         latitude, longitude, star_rating,
         phone, email,
         check_in_time, check_out_time, check_in_time_end,
         front_desk_time_start, front_desk_time_end,
         hotel_chain, is_closed, deleted, is_gender_specification_required,
         star_certificate, metapolicy_extra_info,
         serp_filters, facts, keys_pickup, metapolicy_struct, payment_methods,
         region_id, raw_data
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
         $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
       )
       ON CONFLICT (hotel_id) DO UPDATE SET
         hid                              = EXCLUDED.hid,
         name                             = EXCLUDED.name,
         kind                             = EXCLUDED.kind,
         address                          = EXCLUDED.address,
         postal_code                      = EXCLUDED.postal_code,
         latitude                         = EXCLUDED.latitude,
         longitude                        = EXCLUDED.longitude,
         star_rating                      = EXCLUDED.star_rating,
         phone                            = EXCLUDED.phone,
         email                            = EXCLUDED.email,
         check_in_time                    = EXCLUDED.check_in_time,
         check_out_time                   = EXCLUDED.check_out_time,
         check_in_time_end                = EXCLUDED.check_in_time_end,
         front_desk_time_start            = EXCLUDED.front_desk_time_start,
         front_desk_time_end              = EXCLUDED.front_desk_time_end,
         hotel_chain                      = EXCLUDED.hotel_chain,
         is_closed                        = EXCLUDED.is_closed,
         deleted                          = EXCLUDED.deleted,
         is_gender_specification_required = EXCLUDED.is_gender_specification_required,
         star_certificate                 = EXCLUDED.star_certificate,
         metapolicy_extra_info            = EXCLUDED.metapolicy_extra_info,
         serp_filters                     = EXCLUDED.serp_filters,
         facts                            = EXCLUDED.facts,
         keys_pickup                      = EXCLUDED.keys_pickup,
         metapolicy_struct                = EXCLUDED.metapolicy_struct,
         payment_methods                  = EXCLUDED.payment_methods,
         region_id                        = EXCLUDED.region_id,
         raw_data                         = EXCLUDED.raw_data,
         updated_at                       = NOW()
       RETURNING id`,
      [
        r.id,
        r.hid ?? null,
        r.name ?? null,
        r.kind ?? null,
        r.address ?? null,
        r.postal_code ?? null,
        r.latitude ?? null,
        r.longitude ?? null,
        r.star_rating ?? null,
        r.phone ?? null,
        r.email ?? null,
        r.check_in_time ?? null,
        r.check_out_time ?? null,
        r.check_in_time_end ?? null,
        r.front_desk_time_start ?? null,
        r.front_desk_time_end ?? null,
        r.hotel_chain ?? null,
        r.is_closed ?? false,
        r.deleted ?? false,
        r.is_gender_specification_required ?? false,
        r.star_certificate ?? null,
        r.metapolicy_extra_info ?? null,
        r.serp_filters ?? null,
        r.facts ? JSON.stringify(r.facts) : null,
        r.keys_pickup ? JSON.stringify(r.keys_pickup) : null,
        r.metapolicy_struct ? JSON.stringify(r.metapolicy_struct) : null,
        r.payment_methods ? JSON.stringify(r.payment_methods) : null,
        regionInternalId,
        JSON.stringify(r),
      ],
    );

    const hotelInternalId = hotelRes.rows[0].id;

    // 3. Child records: delete-then-insert (idempotent re-sync)
    await this.replaceImages(client, hotelInternalId, r.images ?? [], r.images_ext ?? []);
    await this.replaceAmenityGroups(client, hotelInternalId, r.amenity_groups ?? []);
    await this.replaceContentSections(client, hotelInternalId, "description", r.description_struct ?? []);
    await this.replaceContentSections(client, hotelInternalId, "policy", r.policy_struct ?? []);
    await this.replaceRoomGroups(client, hotelInternalId, r.room_groups ?? []);
  }

  // ── Child table helpers ───────────────────────────────────────────────────

  private async replaceImages(
    client: PoolClient,
    hotelInternalId: number,
    images: string[],
    imagesExt: Array<{ url: string; category_slug?: string }>,
  ): Promise<void> {
    await client.query("DELETE FROM hotel_images WHERE hotel_id = $1", [hotelInternalId]);
    if (images.length === 0) return;

    // Build a slug map from images_ext for O(1) lookup
    const slugMap = new Map<string, string>();
    for (const ext of imagesExt) {
      if (ext.url && ext.category_slug) slugMap.set(ext.url, ext.category_slug);
    }

    const values: any[] = [];
    const placeholders: string[] = [];
    images.forEach((url, i) => {
      const slug = slugMap.get(url) ?? null;
      values.push(hotelInternalId, url, slug, i);
      const base = i * 4;
      placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
    });

    await client.query(
      `INSERT INTO hotel_images (hotel_id, url, category_slug, sort_order)
       VALUES ${placeholders.join(",")}`,
      values,
    );
  }

  private async replaceAmenityGroups(
    client: PoolClient,
    hotelInternalId: number,
    groups: HotelRecord["amenity_groups"] & {},
  ): Promise<void> {
    await client.query(
      "DELETE FROM hotel_amenity_groups WHERE hotel_id = $1",
      [hotelInternalId],
    );
    if (groups.length === 0) return;

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const gRes = await client.query<{ id: number }>(
        `INSERT INTO hotel_amenity_groups (hotel_id, group_name, sort_order)
         VALUES ($1, $2, $3) RETURNING id`,
        [hotelInternalId, g.group_name, gi],
      );
      const gId = gRes.rows[0].id;

      const amenities = [
        ...(g.amenities ?? []).map((name) => ({ name, is_free: true })),
        ...(g.non_free_amenities ?? []).map((name) => ({ name, is_free: false })),
      ];

      if (amenities.length === 0) continue;

      const vals: any[] = [];
      const phs: string[] = [];
      amenities.forEach((a, ai) => {
        vals.push(gId, a.name, a.is_free);
        const b = ai * 3;
        phs.push(`($${b + 1},$${b + 2},$${b + 3})`);
      });

      await client.query(
        `INSERT INTO hotel_amenities (group_id, name, is_free) VALUES ${phs.join(",")}`,
        vals,
      );
    }
  }

  private async replaceContentSections(
    client: PoolClient,
    hotelInternalId: number,
    sectionType: "description" | "policy",
    sections: Array<{ title: string; paragraphs: string[] }>,
  ): Promise<void> {
    await client.query(
      "DELETE FROM hotel_content_sections WHERE hotel_id = $1 AND section_type = $2",
      [hotelInternalId, sectionType],
    );
    if (sections.length === 0) return;

    const vals: any[] = [];
    const phs: string[] = [];
    sections.forEach((s, i) => {
      vals.push(hotelInternalId, sectionType, s.title ?? null, s.paragraphs ?? [], i);
      const b = i * 5;
      phs.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
    });

    await client.query(
      `INSERT INTO hotel_content_sections (hotel_id, section_type, title, paragraphs, sort_order)
       VALUES ${phs.join(",")}`,
      vals,
    );
  }

  private async replaceRoomGroups(
    client: PoolClient,
    hotelInternalId: number,
    groups: HotelRecord["room_groups"] & {},
  ): Promise<void> {
    await client.query(
      "DELETE FROM hotel_room_groups WHERE hotel_id = $1",
      [hotelInternalId],
    );
    if (groups.length === 0) return;

    const vals: any[] = [];
    const phs: string[] = [];
    groups.forEach((g, i) => {
      const imageUrls = (g.images ?? []).filter((u) => typeof u === "string");
      vals.push(
        hotelInternalId,
        g.room_group_id ?? null,
        g.name ?? null,
        g.name_struct ? JSON.stringify(g.name_struct) : null,
        g.rg_ext ? JSON.stringify(g.rg_ext) : null,
        g.room_amenities ?? null,
        imageUrls.length > 0 ? imageUrls : null,
        g.images_ext ? JSON.stringify(g.images_ext) : null,
      );
      const b = i * 8;
      phs.push(
        `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`,
      );
    });

    await client.query(
      `INSERT INTO hotel_room_groups
         (hotel_id, room_group_id, name, name_struct, rg_ext, room_amenities, images, images_ext)
       VALUES ${phs.join(",")}`,
      vals,
    );
  }

  // ── Streaming batch helper (used by pipeline) ─────────────────────────────

  async insertHotelsBatch(
    onBatch: (insertFn: (batch: HotelRecord[]) => Promise<void>) => Promise<void>,
    options: InsertOptions = {},
  ): Promise<InsertStats> {
    const startTime = Date.now();
    let successfulInserts = 0;
    let totalRecords = 0;
    let failedInserts = 0;
    let rejectedByValidation = 0;
    let validationWarnings = 0;

    await onBatch(async (batch) => {
      totalRecords += batch.length;
      const stats = await this.insertHotels(batch, { batchSize: 50, ...options });
      successfulInserts      += stats.successfulInserts;
      failedInserts          += stats.failedInserts;
      rejectedByValidation   += stats.rejectedByValidation;
      validationWarnings     += stats.validationWarnings;
    });

    closeRejectionLog(); // flush file after streaming completes
    return { totalRecords, successfulInserts, failedInserts, rejectedByValidation, validationWarnings, insertTimeMs: Date.now() - startTime };
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  async getHotelCount(): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query("SELECT COUNT(*) AS count FROM hotels");
      return parseInt(result.rows[0].count, 10);
    } finally {
      client.release();
    }
  }

  async getHotel(hotelId: string): Promise<HotelRecord | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT raw_data FROM hotels WHERE hotel_id = $1",
        [hotelId],
      );
      // pg auto-parses JSONB → already a JS object, no JSON.parse needed
      return result.rows.length > 0 ? (result.rows[0].raw_data as HotelRecord) : null;
    } finally {
      client.release();
    }
  }

  async searchHotels(city: string, minStarRating?: number): Promise<HotelRecord[]> {
    const client = await this.pool.connect();
    try {
      // Join with regions to search by city name
      let query = `
        SELECT h.raw_data
        FROM hotels h
        LEFT JOIN hotel_regions r ON r.id = h.region_id
        WHERE (r.name ILIKE $1 OR h.address ILIKE $1)
      `;
      const params: any[] = [`%${city}%`];

      if (minStarRating !== undefined) {
        query += ` AND h.star_rating >= $2`;
        params.push(minStarRating);
      }

      const result = await client.query(query, params);
      // pg auto-parses JSONB
      return result.rows.map((row) => row.raw_data as HotelRecord);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
      console.log("✓ PostgreSQL connection pool closed");
    } catch (err) {
      console.error("Error closing connection pool:", err);
    }
  }

  // ── Inline DDL fallback (mirrors 001_hotel_schema.sql) ───────────────────

  private inlineDDL(): string {
    return `
      CREATE TABLE IF NOT EXISTS hotel_regions (
        id           BIGSERIAL PRIMARY KEY,
        region_id    BIGINT UNIQUE NOT NULL,
        country_code CHAR(2),
        iata         VARCHAR(10),
        name         TEXT,
        type         VARCHAR(50),
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_hotel_regions_country ON hotel_regions(country_code);
      CREATE INDEX IF NOT EXISTS idx_hotel_regions_name    ON hotel_regions(name);

      CREATE TABLE IF NOT EXISTS hotels (
        id                              BIGSERIAL PRIMARY KEY,
        hotel_id                        VARCHAR(200)  UNIQUE NOT NULL,
        hid                             BIGINT        UNIQUE,
        name                            TEXT,
        kind                            VARCHAR(50),
        address                         TEXT,
        postal_code                     VARCHAR(20),
        latitude                        DECIMAL(11,8),
        longitude                       DECIMAL(11,8),
        star_rating                     DECIMAL(3,1),
        phone                           VARCHAR(100),
        email                           VARCHAR(255),
        check_in_time                   VARCHAR(20),
        check_out_time                  VARCHAR(20),
        check_in_time_end               VARCHAR(20),
        front_desk_time_start           VARCHAR(20),
        front_desk_time_end             VARCHAR(20),
        hotel_chain                     TEXT,
        is_closed                       BOOLEAN DEFAULT false,
        deleted                         BOOLEAN DEFAULT false,
        is_gender_specification_required BOOLEAN DEFAULT false,
        star_certificate                TEXT,
        metapolicy_extra_info           TEXT,
        serp_filters                    TEXT[],
        facts                           JSONB,
        keys_pickup                     JSONB,
        metapolicy_struct               JSONB,
        payment_methods                 JSONB,
        region_id                       BIGINT REFERENCES hotel_regions(id),
        raw_data                        JSONB,
        created_at                      TIMESTAMPTZ DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_hotels_hotel_id     ON hotels(hotel_id);
      CREATE INDEX IF NOT EXISTS idx_hotels_hid          ON hotels(hid);
      CREATE INDEX IF NOT EXISTS idx_hotels_region_id    ON hotels(region_id);
      CREATE INDEX IF NOT EXISTS idx_hotels_star_rating  ON hotels(star_rating);
      CREATE INDEX IF NOT EXISTS idx_hotels_is_closed    ON hotels(is_closed);
      CREATE INDEX IF NOT EXISTS idx_hotels_deleted      ON hotels(deleted);
      CREATE INDEX IF NOT EXISTS idx_hotels_updated_at   ON hotels(updated_at);
      CREATE INDEX IF NOT EXISTS idx_hotels_serp_filters ON hotels USING GIN(serp_filters);

      CREATE TABLE IF NOT EXISTS hotel_images (
        id             BIGSERIAL PRIMARY KEY,
        hotel_id       BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
        url            TEXT   NOT NULL,
        category_slug  VARCHAR(100),
        sort_order     INT DEFAULT 0,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_hotel_images_hotel_id ON hotel_images(hotel_id);

      CREATE TABLE IF NOT EXISTS hotel_amenity_groups (
        id          BIGSERIAL PRIMARY KEY,
        hotel_id    BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
        group_name  TEXT NOT NULL,
        sort_order  INT DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_hotel_amenity_groups_hotel_id ON hotel_amenity_groups(hotel_id);

      CREATE TABLE IF NOT EXISTS hotel_amenities (
        id         BIGSERIAL PRIMARY KEY,
        group_id   BIGINT NOT NULL REFERENCES hotel_amenity_groups(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        is_free    BOOLEAN DEFAULT true
      );
      CREATE INDEX IF NOT EXISTS idx_hotel_amenities_group_id ON hotel_amenities(group_id);

      CREATE TABLE IF NOT EXISTS hotel_content_sections (
        id           BIGSERIAL PRIMARY KEY,
        hotel_id     BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
        section_type VARCHAR(20) NOT NULL,
        title        TEXT,
        paragraphs   TEXT[],
        sort_order   INT DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_hotel_content_sections_hotel_id ON hotel_content_sections(hotel_id);
      CREATE INDEX IF NOT EXISTS idx_hotel_content_sections_type     ON hotel_content_sections(section_type);

      CREATE TABLE IF NOT EXISTS hotel_room_groups (
        id              BIGSERIAL PRIMARY KEY,
        hotel_id        BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
        room_group_id   BIGINT,
        name            TEXT,
        name_struct     JSONB,
        rg_ext          JSONB,
        room_amenities  TEXT[],
        images          TEXT[],
        images_ext      JSONB,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_hotel_room_groups_hotel_id ON hotel_room_groups(hotel_id);

      CREATE OR REPLACE FUNCTION touch_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$;
      DROP TRIGGER IF EXISTS trg_hotels_updated_at ON hotels;
      CREATE TRIGGER trg_hotels_updated_at
        BEFORE UPDATE ON hotels
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    `;
  }
}

export default PostgresService;
export { PostgresService };
