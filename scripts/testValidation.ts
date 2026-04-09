/**
 * Validation gate unit test
 * Run: npx ts-node src/testValidation.ts
 */
import { validateHotel, validateBatch } from "../src/services/hotelValidator";

function pass(label: string) { console.log(`  ✓ ${label}`); }
function fail(label: string) { throw new Error(`FAIL: ${label}`); }
function assert(cond: boolean, label: string) { cond ? pass(label) : fail(label); }

// ─────────────────────────────────────────────────────────────────────────────
// Sample fixture (real structure from API)
// ─────────────────────────────────────────────────────────────────────────────

const GOOD: any = {
  id: "hotel_test_1",
  hid: 12345,
  name: "Test Hotel",
  latitude: 40.7128,
  longitude: -74.006,
  star_rating: 4.5,
  address: "123 Main St",
  postal_code: "10001",
  phone: "+1 212 555 0100",
  email: "info@testhotel.com",
  check_in_time: "14:00:00",
  check_out_time: "12:00:00",
  region: { id: 5001, country_code: "US", iata: "NYC", name: "New York", type: "City" },
  images: [
    "https://cdn.worldota.net/t/{size}/img1.jpeg",
    "https://cdn.worldota.net/t/{size}/img2.jpeg",
  ],
  images_ext: [
    { url: "https://cdn.worldota.net/t/{size}/img1.jpeg", category_slug: "exterior" },
  ],
  amenity_groups: [
    { group_name: "General", amenities: ["WiFi", "Heating"], non_free_amenities: [] },
  ],
  description_struct: [
    { title: "Location", paragraphs: ["Great location in midtown."] },
  ],
  policy_struct: [
    { title: "Meals", paragraphs: ["Breakfast included."] },
  ],
  room_groups: [],
  serp_filters: ["has_internet"],
  is_closed: false,
  deleted: false,
  is_gender_specification_required: false,
  hotel_chain: "No chain",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║           Validation Gate Tests                       ║");
console.log("╚══════════════════════════════════════════════════════╝\n");

// ── 1. Valid record passes ────────────────────────────────────────────────────
console.log("▶ 1. Valid record");
{
  const r = validateHotel({ ...GOOD });
  assert(r.valid, "Valid record passes");
  assert(r.issues.length === 0, "No issues on clean record");
}

// ── 2. Missing id → rejected ──────────────────────────────────────────────────
console.log("\n▶ 2. Missing id");
{
  const r = validateHotel({ ...GOOD, id: undefined });
  assert(!r.valid, "Missing id → rejected");
  assert(r.issues.some(i => i.field === "id" && i.severity === "error"), "Error on id field");
}

// ── 3. Empty string id → rejected ────────────────────────────────────────────
console.log("\n▶ 3. Empty string id");
{
  const r = validateHotel({ ...GOOD, id: "   " });
  assert(!r.valid, "Blank id → rejected");
}

// ── 4. Not an object → rejected ───────────────────────────────────────────────
console.log("\n▶ 4. Non-object record");
{
  const r = validateHotel("just a string");
  assert(!r.valid, "Non-object → rejected");
}

// ── 5. Latitude out of range → warning, coords cleared ───────────────────────
console.log("\n▶ 5. Latitude out of range");
{
  const r = validateHotel({ ...GOOD, latitude: 999 });
  assert(r.valid, "Out-of-range lat → still valid (warning only)");
  assert(r.record.latitude == null, "Latitude cleared");
  assert(r.record.longitude == null, "Longitude cleared (paired)");
  assert(r.issues.some(i => i.field === "latitude" && i.severity === "warning"), "Warning on latitude");
}

// ── 6. Only latitude, no longitude → warning, both cleared ───────────────────
console.log("\n▶ 6. Only latitude (no longitude)");
{
  const r = validateHotel({ ...GOOD, longitude: undefined });
  assert(r.valid, "Unpaired lat → valid but warned");
  assert(r.record.latitude == null, "Latitude cleared");
  assert(r.record.longitude == null, "Longitude cleared");
}

// ── 7. Star rating out of range → cleared ────────────────────────────────────
console.log("\n▶ 7. Star rating out of range");
{
  const r = validateHotel({ ...GOOD, star_rating: 10 });
  assert(r.valid, "star_rating 10 → valid with warning");
  assert(r.record.star_rating == null, "star_rating cleared");
}

// ── 8. String-encoded number coerced ─────────────────────────────────────────
console.log("\n▶ 8. String-encoded star_rating");
{
  const r = validateHotel({ ...GOOD, star_rating: "3.5", hid: "99999" });
  assert(r.valid, "String numbers coerced");
  assert(r.record.star_rating === 3.5, `star_rating coerced to 3.5 (got ${r.record.star_rating})`);
  assert(r.record.hid === 99999, `hid coerced to 99999 (got ${r.record.hid})`);
}

// ── 9. Name too long → truncated ──────────────────────────────────────────────
console.log("\n▶ 9. Name too long → truncated");
{
  const longName = "A".repeat(2000);
  const r = validateHotel({ ...GOOD, name: longName });
  assert(r.valid, "Too-long name → valid with warning");
  assert((r.record.name ?? "").length === 1000, `Name truncated to 1000 (got ${(r.record.name ?? "").length})`);
  assert(r.issues.some(i => i.field === "name" && i.severity === "warning"), "Warning on name truncation");
}

// ── 10. images array with non-strings → filtered ──────────────────────────────
console.log("\n▶ 10. images with non-string entries");
{
  const r = validateHotel({
    ...GOOD,
    images: ["https://cdn.example.com/img.jpg", 42, null, "https://cdn.example.com/img2.jpg"],
  });
  assert(r.valid, "Mixed image array → valid");
  assert(r.record.images?.length === 2, `Non-string images filtered (got ${r.record.images?.length})`);
}

// ── 11. amenity_groups not an array → cleared ────────────────────────────────
console.log("\n▶ 11. amenity_groups wrong type");
{
  const r = validateHotel({ ...GOOD, amenity_groups: "wifi, pool" });
  assert(r.valid, "amenity_groups string → valid (cleared)");
  assert(Array.isArray(r.record.amenity_groups) && r.record.amenity_groups.length === 0, "amenity_groups cleared to []");
}

// ── 12. region without id → region cleared ───────────────────────────────────
console.log("\n▶ 12. region with bad id");
{
  const r = validateHotel({ ...GOOD, region: { id: "not-a-number", country_code: "US" } });
  assert(r.valid, "Bad region.id → valid (region cleared)");
  assert(r.record.region === undefined, "Region cleared");
}

// ── 13. Missing boolean flags → defaulted ────────────────────────────────────
console.log("\n▶ 13. Missing boolean flags");
{
  const { is_closed, deleted, is_gender_specification_required, ...rest } = GOOD;
  const r = validateHotel(rest);
  assert(r.valid, "Missing booleans → valid");
  assert(r.record.is_closed === false, "is_closed defaults to false");
  assert(r.record.deleted === false, "deleted defaults to false");
}

// ── 14. Batch: mix of valid, warned, rejected ─────────────────────────────────
console.log("\n▶ 14. Batch validation");
{
  const batch = [
    { ...GOOD, id: "h1" },                              // clean
    { ...GOOD, id: "h2", star_rating: 99 },             // warned (coerced)
    { ...GOOD, id: undefined },                         // rejected (no id)
    { ...GOOD, id: "h1" },                              // rejected (duplicate)
    { ...GOOD, id: "h3", name: "B".repeat(1500) },      // warned (truncated)
  ];

  const vr = validateBatch(batch);
  assert(vr.stats.total === 5, `total = 5 (got ${vr.stats.total})`);
  assert(vr.stats.passed === 3, `passed = 3 (got ${vr.stats.passed})`);
  assert(vr.stats.warned === 2, `warned = 2 (got ${vr.stats.warned})`);
  assert(vr.stats.rejected === 2, `rejected = 2 (got ${vr.stats.rejected})`);
  assert(vr.valid.map(r => r.id).join(",") === "h1,h2,h3", `valid ids in order`);
  assert(vr.rejected.some(r => r.errors[0]?.field === "id"), "One rejection has field=id");
}

// ── 15. description_struct with malformed section ────────────────────────────
console.log("\n▶ 15. description_struct with malformed section");
{
  const r = validateHotel({
    ...GOOD,
    description_struct: [
      { title: "Good section", paragraphs: ["text"] },
      { title: 42, paragraphs: "not-array" }, // paragraphs must be array
      "totally wrong",
    ],
  });
  assert(r.valid, "Partial bad description_struct → valid");
  assert(r.record.description_struct?.length === 1, `Bad sections filtered (got ${r.record.description_struct?.length})`);
}

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║              All validation tests passed ✓            ║");
console.log("╚══════════════════════════════════════════════════════╝\n");
