# Quick Reference Card

## Command Cheat Sheet

```bash
# Setup
cp .env.example .env              # Create environment file
npm install                       # Install dependencies
npm run build                     # Compile TypeScript

# Run Pipeline
npm run pipeline                  # Execute full pipeline
npm run dev                       # Run original dump service

# Database
psql -h localhost -d hotel_sync   # Connect to database
```

## Environment Variables

```env
# Required
KEY_ID=your_api_key_id
API_KEY=your_api_key
AWS_REGION=us-east-1
S3_BUCKET=bucket-name
AWS_ACCESS_KEY_ID=access_key
AWS_SECRET_ACCESS_KEY=secret_key
DB_HOST=localhost
DB_NAME=hotel_sync
DB_USER=postgres
DB_PASSWORD=password

# Optional (defaults work fine)
DB_PORT=5432
DOWNLOAD_DIR=./downloads
BATCH_SIZE=200
KEEP_LOCAL_FILES=false
```

## SQL Queries

```sql
-- Count hotels
SELECT COUNT(*) FROM hotels;

-- Top 10 cities
SELECT city, COUNT(*) as cnt
FROM hotels
GROUP BY city
ORDER BY cnt DESC LIMIT 10;

-- Hotels by star rating
SELECT star_rating, COUNT(*)
FROM hotels
GROUP BY star_rating
ORDER BY star_rating DESC;

-- Search hotels
SELECT id, name, city, country, star_rating
FROM hotels
WHERE city ILIKE '%paris%'
ORDER BY star_rating DESC;

-- Recent updates
SELECT name, city, updated_at
FROM hotels
ORDER BY updated_at DESC LIMIT 20;
```

## Service Quick Start

```typescript
// Import services
import { HotelDumpService, PostgresService, HotelSyncPipeline } from "./src";

// Use pipeline (easiest)
const pipeline = new HotelSyncPipeline(config);
await pipeline.run();

// Or use individual services
const dump = new HotelDumpService(dumpConfig);
const db = new PostgresService(dbConfig);

const url = (await dump.fetchDumpUrl()).data.url;
const compressed = await dump.downloadDump(url);
const decompressed = await dump.decompressDump(compressed);
const records = await dump.parseDump(decompressed);
await db.insertHotels(records);
```

## Configuration Quick Start

```typescript
const config = {
  // API
  keyId: process.env.KEY_ID!,
  apiKey: process.env.API_KEY!,
  inventory: "all",
  language: "en",

  // S3
  s3Config: {
    region: process.env.AWS_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },

  // Database
  postgresConfig: {
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME!,
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
  },

  // Options
  batchSize: 200,
  keepLocalFiles: false,
};

const pipeline = new HotelSyncPipeline(config);
const stats = await pipeline.run();
```

## Troubleshooting

| Problem               | Solution                                |
| --------------------- | --------------------------------------- |
| DB connection refused | `psql -h localhost` to test; check .env |
| S3 upload fails       | `aws s3 ls` to test credentials         |
| Out of memory         | Reduce `batchSize` to 50-100            |
| Slow inserts          | Increase `maxConnections` to 50         |
| No dump URL           | Check API credentials are correct       |
| Disk full             | Need 25-30 GB free space                |

## File Locations

| File                                 | Purpose               |
| ------------------------------------ | --------------------- |
| `src/services/hotelDumpService.ts`   | Download & decompress |
| `src/services/postgresService.ts`    | Database operations   |
| `src/services/s3StreamService.ts`    | S3 streaming          |
| `src/pipelines/hotelSyncPipeline.ts` | Main orchestrator     |
| `src/pipelines/usage.ts`             | Entry point           |

## Performance Tips

- **Faster downloads**: Use larger batch size (500+)
- **More memory**: Increase `maxConnections` to 50
- **Slower machine**: Reduce batch size to 25
- **Small disk**: Enable `keepLocalFiles: false`

## Expected Output

```
Step 0: Testing database connection...
✓ PostgreSQL connection successful
✓ Hotels table ready

Step 1: Fetching and downloading dump file...
✓ Dump file downloaded: 2,345.67MB
  Time: 145.23s

Step 2: Decompressing and uploading to S3...
✓ File decompressed and uploaded to S3
  Time: 52.10s

Step 3: Streaming from S3 and inserting...
  Processed 250 batches
✓ Streamed 50,000 hotel records
  Time: 312.45s

Performance Summary:
  Download:      145.23s
  Decompress:    52.10s
  Database:      312.45s
  Total:         509.78s

Data Summary:
  Total:         50,000
  Successful:    49,850
  Failed:        150
  Success Rate:  99.70%
```

## Database Schema Quick View

```sql
hotels {
  id              SERIAL PRIMARY KEY
  hotel_id        VARCHAR (unique) ← Upsert key
  name            VARCHAR
  city            VARCHAR (indexed)
  country         VARCHAR (indexed)
  star_rating     DECIMAL (indexed)
  latitude        DECIMAL
  longitude       DECIMAL
  address         VARCHAR
  images          TEXT[]
  amenities       TEXT[]
  raw_data        JSONB ← Complete original data
  created_at      TIMESTAMP
  updated_at      TIMESTAMP (indexed)
}
```

## Common Issues & Fixes

### "Connection refused"

```bash
# Check PostgreSQL is running
brew services start postgresql  # macOS
sudo systemctl start postgres   # Linux

# Test connection
psql -h localhost
```

### "InvalidAccessKeyId"

```bash
# Verify AWS credentials
cat .env | grep AWS_
aws s3 ls  # Test AWS CLI
```

### "Out of memory"

```typescript
// In hotelSyncPipeline config:
batchSize: 50,  // Smaller batches
```

### Pipeline takes too long

```typescript
// Increase database connections:
postgresConfig: {
  // ...
  maxConnections: 50,  // From 20
}
```

## Documentation Files

- **QUICKSTART.md** - 5-minute setup (start here!)
- **README.md** - Full documentation
- **ARCHITECTURE.md** - Technical details
- **SOLUTION_OVERVIEW.md** - Complete guide
- **IMPLEMENTATION_SUMMARY.md** - What was built

## Support

1. Check **QUICKSTART.md** for setup issues
2. Review **ARCHITECTURE.md** for technical questions
3. See **README.md** for detailed docs
4. Check database logs: `SELECT pg_current_logfile();`
5. Check S3 bucket: `aws s3 ls s3://your-bucket/`

---

**Everything you need to run the complete pipeline!** ⚡
