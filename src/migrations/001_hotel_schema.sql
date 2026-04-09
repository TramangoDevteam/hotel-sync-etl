-- ============================================================
-- Hotel Sync – Full Relational Schema
-- Based on real WorldOTA API structure (verified at runtime)
--
-- Run once against the target database:
--   psql $DATABASE_URL -f 001_hotel_schema.sql
-- ============================================================

-- ── Regions / locations ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS hotel_regions (
  id           BIGSERIAL PRIMARY KEY,
  region_id    BIGINT UNIQUE NOT NULL,   -- API region.id
  country_code CHAR(2),                  -- "US", "RU" …
  iata         VARCHAR(10),              -- airport / city IATA code
  name         TEXT,                     -- city / region name
  type         VARCHAR(50),              -- "City", "Country", …
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hotel_regions_country ON hotel_regions(country_code);
CREATE INDEX IF NOT EXISTS idx_hotel_regions_name    ON hotel_regions(name);

-- ── Core hotel record ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hotels (
  id                              BIGSERIAL PRIMARY KEY,
  hotel_id                        VARCHAR(200)  UNIQUE NOT NULL,  -- API id  (string slug)
  hid                             BIGINT        UNIQUE,           -- API hid (numeric)
  name                            TEXT,
  kind                            VARCHAR(50),                    -- "Hotel", "Hostel" …
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
  serp_filters                    TEXT[],          -- e.g. ["has_internet","has_pool"]
  facts                           JSONB,            -- floors_number, rooms_number, electricity …
  keys_pickup                     JSONB,
  metapolicy_struct               JSONB,
  payment_methods                 JSONB,
  region_id                       BIGINT REFERENCES hotel_regions(id),
  raw_data                        JSONB,            -- complete original record
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

-- ── Images ──────────────────────────────────────────────────
-- images[]     → plain CDN URL strings (with {size} placeholder)
-- images_ext[] → richer objects with category_slug
CREATE TABLE IF NOT EXISTS hotel_images (
  id             BIGSERIAL PRIMARY KEY,
  hotel_id       BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  url            TEXT   NOT NULL,
  category_slug  VARCHAR(100),   -- from images_ext (e.g. "guest_rooms", "bathroom")
  sort_order     INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hotel_images_hotel_id ON hotel_images(hotel_id);

-- ── Amenity groups + individual amenities ────────────────────
-- amenity_groups[].group_name  → e.g. "General", "Internet"
-- amenity_groups[].amenities[] → free amenity names
-- amenity_groups[].non_free_amenities[] → paid amenity names
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
  is_free    BOOLEAN DEFAULT true    -- false = paid / non_free amenity
);

CREATE INDEX IF NOT EXISTS idx_hotel_amenities_group_id ON hotel_amenities(group_id);

-- ── Description / policy sections ───────────────────────────
-- description_struct[] and policy_struct[] share the same shape:
--   { title: string, paragraphs: string[] }
CREATE TABLE IF NOT EXISTS hotel_content_sections (
  id           BIGSERIAL PRIMARY KEY,
  hotel_id     BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  section_type VARCHAR(20) NOT NULL,   -- 'description' | 'policy'
  title        TEXT,
  paragraphs   TEXT[],                 -- ordered list of paragraph strings
  sort_order   INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hotel_content_sections_hotel_id ON hotel_content_sections(hotel_id);
CREATE INDEX IF NOT EXISTS idx_hotel_content_sections_type     ON hotel_content_sections(section_type);

-- ── Room groups ──────────────────────────────────────────────
-- room_groups[]:
--   room_group_id, name, name_struct{bathroom,bedding_type,main_name},
--   rg_ext{class,quality,sex,bathroom,bedding,…},
--   room_amenities[], images[], images_ext[]
CREATE TABLE IF NOT EXISTS hotel_room_groups (
  id              BIGSERIAL PRIMARY KEY,
  hotel_id        BIGINT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  room_group_id   BIGINT,               -- API room_group_id
  name            TEXT,
  name_struct     JSONB,                -- {bathroom, bedding_type, main_name}
  rg_ext          JSONB,                -- room classification bits
  room_amenities  TEXT[],              -- e.g. ["wifi","heating","tv"]
  images          TEXT[],              -- URL strings (same {size} placeholder)
  images_ext      JSONB,               -- [{url, category_slug}]
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hotel_room_groups_hotel_id ON hotel_room_groups(hotel_id);

-- ── Updated-at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hotels_updated_at ON hotels;
CREATE TRIGGER trg_hotels_updated_at
  BEFORE UPDATE ON hotels
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
