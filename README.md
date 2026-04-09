# hotel-sync

ETL pipeline that streams hotel data from the WorldOTA/RateHawk API dump directly into a normalized PostgreSQL schema — no full decompressed file ever written to disk.

```
WorldOTA API → download .zst → zstd decompress (stream) → S3 → PostgreSQL
```

---

## How it works

1. **Fetch** — call the WorldOTA API to get a presigned dump URL
2. **Download + decompress** — stream the `.zst` file through `zstd -d` and pipe directly into S3 multipart upload (no local disk for the decompressed file)
3. **Stream from S3** — read the JSONL file line-by-line in configurable batches
4. **Validate** — run each record through the validation gate (coerce fixable issues, reject genuinely broken records)
5. **Insert** — upsert into 7 normalized PostgreSQL tables

---

## Prerequisites

- Node.js 18+
- PostgreSQL 13+
- `zstd` CLI — `brew install zstd` / `apt install zstd`
- AWS S3 bucket
- WorldOTA API credentials

---

## Setup

```bash
npm install
cp .env.example .env
# fill in .env
```

`.env` keys:

```
KEY_ID=14224
API_KEY=your-api-key

AWS_REGION=us-east-1
S3_BUCKET=your-bucket
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

DB_HOST=localhost
DB_PORT=5432
DB_NAME=hotel_sync
DB_USER=postgres
DB_PASSWORD=your-password
DB_SSL=true          # set false for local postgres
```

---

## Run

```bash
# Full pipeline (download → S3 → PostgreSQL)
npx ts-node scripts/pipelineUsageExample.ts

# Or build first
npm run build
npm start
```

---

## Database schema

7 tables, all created automatically on first run via `createSchema()`.

```
hotel_regions          region lookup (country, city, IATA code)
    │
    └── hotels         one row per hotel; FKs to hotel_regions
            │
            ├── hotel_images           CDN URL strings + category slug
            ├── hotel_amenity_groups   "General", "Internet", "Rooms" …
            │       └── hotel_amenities    individual amenity names + free/paid flag
            ├── hotel_content_sections description and policy text blocks
            └── hotel_room_groups      room type definitions + rg_ext metadata
```

Key columns on `hotels`:

| Column               | Source field                | Notes                               |
| -------------------- | --------------------------- | ----------------------------------- |
| `hotel_id`           | `record.id`                 | string slug, unique key             |
| `hid`                | `record.hid`                | numeric API id                      |
| `name`               | `record.name`               | plain string                        |
| `address`            | `record.address`            | full address string                 |
| `postal_code`        | `record.postal_code`        | not `zip_code`                      |
| `latitude/longitude` | `record.latitude/longitude` | cleared if out of range             |
| `star_rating`        | `record.star_rating`        | 0–5, cleared if out of range        |
| `region_id`          | FK → `hotel_regions.id`     | from `record.region` object         |
| `serp_filters`       | `record.serp_filters`       | `TEXT[]`, GIN indexed               |
| `facts`              | `record.facts`              | JSONB (rooms count, electricity, …) |
| `raw_data`           | full record                 | JSONB, always stored                |

Fields that **do not exist** in the real API (confirmed by runtime inspection):
`description`, `country`, `state`, `city`, `zip_code`, `fax`, `website`, `amenities`, `languages`

---

## Validation gate

Every batch runs through `hotelValidator.validateBatch()` before any DB work:

| Issue                              | Action                            |
| ---------------------------------- | --------------------------------- |
| Missing/blank `id`                 | **Reject** — record dropped       |
| Duplicate `id` in same batch       | **Reject** — second one dropped   |
| Non-object record                  | **Reject**                        |
| Lat/lng out of range or unpaired   | **Warn** — coords cleared to null |
| `star_rating` outside 0–5          | **Warn** — cleared to null        |
| String-encoded numbers (`"3.5"`)   | **Coerce** silently               |
| Field exceeds length limit         | **Warn** — truncated              |
| Wrong-type arrays / nested objects | **Warn** — cleared or filtered    |
| Missing boolean flags              | **Default** to `false`            |

Rejected records are appended to `downloads/rejected_YYYY-MM-DD.jsonl` so you can inspect and replay them.

Skip validation with `insertHotels(batch, { validate: false })` if you need maximum throughput and trust the source.

---

## Scripts

All runnable scripts are in `scripts/`. Run with `npx ts-node scripts/<file>.ts`.

| Script                      | Purpose                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `testHotelStructure.ts [N]` | Stream N real records from the API and print their exact JSON structure + mapping check. No DB needed. |
| `testEndToEnd.ts`           | Fetch 5 real hotels, insert them, verify every table and field. Needs DB.                              |
| `testValidation.ts`         | Unit-test the validation gate with 15 intentional malformed inputs. No DB, no API.                     |
| `pipelineUsageExample.ts`   | Full pipeline example (same as `npm start`).                                                           |
| `serviceUsageExample.ts`    | Lower-level `HotelDumpService` usage examples.                                                         |
| `schemaInspector.ts`        | Deeper schema analysis — downloads a sample and generates suggested DDL.                               |

```bash
# Inspect real hotel structure (fastest sanity check — no DB needed)
npx ts-node scripts/testHotelStructure.ts 5

# Validate your DB setup end-to-end
DB_HOST=localhost DB_PORT=5432 DB_NAME=hotel_sync DB_USER=postgres DB_PASSWORD=x DB_SSL=false \
npx ts-node scripts/testEndToEnd.ts

# Run validation unit tests
npx ts-node scripts/testValidation.ts
```

---

## Services

### `HotelDumpService`

Downloads and decompresses the dump file.

```typescript
const svc = new HotelDumpService({ keyId, apiKey, downloadDir: "./downloads" });
const url = await svc.fetchDumpUrl();
const compressed = await svc.downloadDump(url.data.url);
const jsonl = await svc.decompressDump(compressed);
await svc.parseDump(jsonl, async (batch) => {
  /* process batch */
});
```

### `PostgresService`

```typescript
const db = new PostgresService({ host, port, database, user, password, ssl });
await db.testConnection();
await db.createSchema(); // idempotent, creates all 7 tables

const stats = await db.insertHotels(records, {
  batchSize: 100,
  validate: true, // default — run validation gate
  rejectionLog: { dir: "./downloads" },
});
// stats: { totalRecords, successfulInserts, failedInserts, rejectedByValidation, validationWarnings }

const hotel = await db.getHotel("welcome_perm");
const results = await db.searchHotels("Perm", 3); // city substring + min stars
```

### `S3StreamService`

```typescript
// Decompress .zst and stream directly to S3 (no local disk)
await decompressStreamToS3(compressedPath, s3Config, "hotel_dump.jsonl");

// Stream JSONL from S3 in batches
await streamHotelsFromS3(
  s3Config,
  "hotel_dump.jsonl",
  async (batch) => {
    await db.insertHotels(batch);
  },
  200,
);
```

---

## Known limitations / next improvements

- **No amenity search index** — querying "hotels with WiFi" requires a full table scan on `hotel_amenities`. Add a covering index or a normalized amenity lookup table when that becomes a query pattern.
- **Child rows always replaced** — on upsert, all images/amenities/sections for a hotel are deleted and reinserted even if unchanged. Acceptable for a nightly sync; inefficient for high-frequency partial updates.
- **No dead-letter retry** — records rejected by the validation gate are written to a JSONL file but not automatically retried. Manual replay required.
- **S3 is required** — the pipeline uses S3 as the intermediate store between decompression and DB insert. A direct decompress-to-DB mode (skipping S3) would be useful for local/dev runs.

---

## License

MIT
