/**
 * End-to-end test: fetch 5 real hotels from the API → insert into PostgreSQL
 *
 * Run:  npx ts-node src/testEndToEnd.ts
 *
 * Verifies:
 *  1. Schema creation (all 7 tables)
 *  2. Correct field mapping from real API data
 *  3. Relational inserts (regions, images, amenities, content sections, room groups)
 *  4. Upsert idempotency (run twice, count stays the same)
 *  5. Query helpers (searchHotels, getHotel)
 */
import "dotenv/config";
import https from "https";
import { spawn } from "child_process";
import { createInterface } from "readline";
import axios from "axios";
import PostgresService from "../src/services/postgresService";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const KEY_ID  = (process.env.KEY_ID  ?? "").trim();
const API_KEY = (process.env.API_KEY ?? "").trim().replace(/^"|"$/g, "");

const db = new PostgresService({
  host:     process.env.DB_HOST!,
  port:     process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  database: process.env.DB_NAME!,
  user:     process.env.DB_USER!,
  password: process.env.DB_PASSWORD!,
  ssl:
    process.env.DB_SSL !== "false"
      ? { rejectUnauthorized: false }
      : false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch real records from API
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDumpUrl(): Promise<string> {
  const res = await axios.post<any>(
    "https://api.worldota.net/api/b2b/v3/hotel/info/dump/",
    { inventory: "all", language: "en" },
    {
      auth: { username: KEY_ID, password: API_KEY },
      headers: { "Content-Type": "application/json" },
      timeout: 30_000,
    },
  );
  const url = res.data?.data?.url;
  if (!url) throw new Error(`No URL in response: ${JSON.stringify(res.data)}`);
  return url;
}

async function streamFirstRecords(dumpUrl: string, count: number): Promise<any[]> {
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

    const zstd = spawn("zstd", ["-d", "--stdout", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    zstd.on("error", (e) => { if (!done) reject(e); });

    const rl = createInterface({ input: zstd.stdout, crlfDelay: Infinity });
    rl.on("line", (line: string) => {
      if (done) return;
      const t = line.trim();
      if (!t || !t.startsWith("{")) return;
      try {
        records.push(JSON.parse(t));
        if (records.length >= count) finish();
      } catch { /* skip */ }
    });
    rl.on("close", () => { if (!done) finish(); });

    let httpRes: any = null;
    const req = https.get(dumpUrl, (res) => {
      httpRes = res;
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.destroy(); return; }
      res.pipe(zstd.stdin, { end: true });
      res.on("error", (e) => { if (!done) reject(e); });
    });
    req.on("error", (e) => { if (!done) reject(e); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║            Hotel Sync – End-to-End Test               ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ── 1. DB connection ──────────────────────────────────────────────────────
  console.log("▶ 1. Testing DB connection...");
  await db.testConnection();

  // ── 2. Schema creation ────────────────────────────────────────────────────
  console.log("\n▶ 2. Creating schema...");
  await db.createSchema();

  // Verify all expected tables exist
  const { Pool } = await import("pg");
  const rawPool = (db as any).pool as import("pg").Pool;
  const tablesRes = await rawPool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  const tableNames = tablesRes.rows.map((r: any) => r.table_name as string);
  console.log("  Tables in DB:", tableNames.join(", "));

  for (const t of [
    "hotels",
    "hotel_amenities",
    "hotel_amenity_groups",
    "hotel_content_sections",
    "hotel_images",
    "hotel_regions",
    "hotel_room_groups",
  ]) {
    assert(tableNames.includes(t), `Table '${t}' exists`);
  }

  // ── 3. Fetch real hotel records from API ──────────────────────────────────
  console.log("\n▶ 3. Fetching 5 real hotels from WorldOTA API...");
  const dumpUrl = await fetchDumpUrl();
  const records = await streamFirstRecords(dumpUrl, 5);
  assert(records.length === 5, `Got 5 hotel records`);

  // ── 4. Insert hotels ──────────────────────────────────────────────────────
  console.log("\n▶ 4. Inserting hotels into DB...");
  const stats = await db.insertHotels(records, { batchSize: 5 });
  assert(stats.successfulInserts === 5, `5 hotels inserted (got ${stats.successfulInserts})`);
  assert(stats.failedInserts === 0, `0 failed inserts`);

  // ── 5. Count in each table ────────────────────────────────────────────────
  console.log("\n▶ 5. Verifying relational data...");

  const hotelCount = await db.getHotelCount();
  assert(hotelCount >= 5, `hotels table has ≥ 5 rows (got ${hotelCount})`);

  const regionCount = (await rawPool.query("SELECT COUNT(*) FROM hotel_regions")).rows[0].count;
  assert(parseInt(regionCount) >= 1, `hotel_regions has ≥ 1 rows (got ${regionCount})`);

  const imageCount = (await rawPool.query("SELECT COUNT(*) FROM hotel_images")).rows[0].count;
  console.log(`  hotel_images: ${imageCount} rows`);

  const amenityGroupCount = (await rawPool.query("SELECT COUNT(*) FROM hotel_amenity_groups")).rows[0].count;
  console.log(`  hotel_amenity_groups: ${amenityGroupCount} rows`);

  const amenityCount = (await rawPool.query("SELECT COUNT(*) FROM hotel_amenities")).rows[0].count;
  console.log(`  hotel_amenities: ${amenityCount} rows`);

  const contentCount = (await rawPool.query("SELECT COUNT(*) FROM hotel_content_sections")).rows[0].count;
  console.log(`  hotel_content_sections: ${contentCount} rows`);

  const roomGroupCount = (await rawPool.query("SELECT COUNT(*) FROM hotel_room_groups")).rows[0].count;
  console.log(`  hotel_room_groups: ${roomGroupCount} rows`);

  // ── 6. Verify field mapping on first record ───────────────────────────────
  console.log("\n▶ 6. Verifying field mapping on first record...");
  const first = records[0];
  const dbRow = (await rawPool.query(
    `SELECT h.*, r.country_code, r.name AS region_name
     FROM hotels h
     LEFT JOIN hotel_regions r ON r.id = h.region_id
     WHERE h.hotel_id = $1`,
    [first.id],
  )).rows[0];

  assert(dbRow != null, `Hotel ${first.id} found in DB`);
  assert(dbRow.hotel_id === first.id, `hotel_id matches`);
  assert(dbRow.name === first.name, `name matches: "${dbRow.name}"`);
  assert(dbRow.latitude == first.latitude, `latitude matches: ${dbRow.latitude}`);
  assert(dbRow.longitude == first.longitude, `longitude matches: ${dbRow.longitude}`);
  assert(dbRow.star_rating == first.star_rating, `star_rating matches: ${dbRow.star_rating}`);
  assert(dbRow.postal_code === (first.postal_code ?? null), `postal_code matches: ${dbRow.postal_code}`);
  assert(dbRow.address === (first.address ?? null), `address matches`);
  assert(dbRow.check_in_time === (first.check_in_time ?? null), `check_in_time matches`);
  assert(dbRow.check_out_time === (first.check_out_time ?? null), `check_out_time matches`);
  if (first.region?.country_code) {
    assert(dbRow.country_code === first.region.country_code, `region country_code matches: ${dbRow.country_code}`);
  }
  if (first.region?.name) {
    assert(dbRow.region_name === first.region.name, `region name matches: ${dbRow.region_name}`);
  }

  // ── 7. Verify images are stored ───────────────────────────────────────────
  if ((first.images ?? []).length > 0) {
    const images = (await rawPool.query(
      `SELECT url, category_slug, sort_order
       FROM hotel_images
       WHERE hotel_id = (SELECT id FROM hotels WHERE hotel_id = $1)
       ORDER BY sort_order`,
      [first.id],
    )).rows;

    assert(images.length === (first.images ?? []).length, `Images count matches: ${images.length}`);
    assert(images[0].url === first.images![0], `First image URL matches`);
    console.log(`  Image sample: ${images[0].url.substring(0, 60)}…`);
    if (images[0].category_slug) {
      console.log(`  Image category: ${images[0].category_slug}`);
    }
  }

  // ── 8. Verify amenities ────────────────────────────────────────────────────
  if ((first.amenity_groups ?? []).length > 0) {
    const groups = (await rawPool.query(
      `SELECT ag.group_name, ag.sort_order, COUNT(a.id) AS amenity_count
       FROM hotel_amenity_groups ag
       LEFT JOIN hotel_amenities a ON a.group_id = ag.id
       WHERE ag.hotel_id = (SELECT id FROM hotels WHERE hotel_id = $1)
       GROUP BY ag.group_name, ag.sort_order
       ORDER BY ag.sort_order`,
      [first.id],
    )).rows;

    assert(groups.length === first.amenity_groups!.length, `Amenity groups count matches: ${groups.length}`);
    console.log(`  Amenity groups: ${groups.map((g: any) => `${g.group_name}(${g.amenity_count})`).join(", ")}`);
  }

  // ── 9. Verify description sections ────────────────────────────────────────
  if ((first.description_struct ?? []).length > 0) {
    const sections = (await rawPool.query(
      `SELECT title, array_length(paragraphs, 1) AS para_count
       FROM hotel_content_sections
       WHERE hotel_id = (SELECT id FROM hotels WHERE hotel_id = $1)
         AND section_type = 'description'
       ORDER BY sort_order`,
      [first.id],
    )).rows;

    assert(sections.length === first.description_struct!.length, `Description sections count matches: ${sections.length}`);
    console.log(`  Description sections: ${sections.map((s: any) => s.title).join(", ")}`);
  }

  // ── 10. Upsert idempotency ────────────────────────────────────────────────
  console.log("\n▶ 10. Testing upsert idempotency (insert same 5 records again)...");
  const stats2 = await db.insertHotels(records, { batchSize: 5 });
  assert(stats2.successfulInserts === 5, `Re-insert succeeded: ${stats2.successfulInserts}`);
  assert(stats2.failedInserts === 0, `No failures on re-insert`);

  const hotelCount2 = await db.getHotelCount();
  assert(hotelCount2 === hotelCount, `Hotel count unchanged after upsert: ${hotelCount2}`);

  // ── 11. getHotel ──────────────────────────────────────────────────────────
  console.log("\n▶ 11. Testing getHotel()...");
  const fetched = await db.getHotel(first.id);
  assert(fetched !== null, `getHotel(${first.id}) returned a record`);
  assert(fetched!.id === first.id, `Fetched hotel id matches`);

  // ── 12. searchHotels ──────────────────────────────────────────────────────
  console.log("\n▶ 12. Testing searchHotels()...");
  if (first.region?.name) {
    const cityPart = first.region.name.split(" ")[0]; // first word of city
    const results = await db.searchHotels(cityPart);
    assert(results.length >= 1, `searchHotels("${cityPart}") returned ≥ 1 result`);
  }

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║              All tests passed ✓                       ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
}

// ─────────────────────────────────────────────────────────────────────────────

runTests()
  .catch((err) => {
    console.error("\n✗ Test failed:", err.message ?? err);
    process.exit(1);
  })
  .finally(() => db.close());
