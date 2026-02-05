# Quick Start Guide

## Pipeline: Download → Decompress to S3 → PostgreSQL

This guide will get you running in 5 minutes.

### Step 1: Environment Setup

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
# Edit .env with your actual credentials
nano .env
```

Required credentials:

- **WorldOTA API**: KEY_ID, API_KEY
- **AWS S3**: AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
- **PostgreSQL**: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD

### Step 2: Install & Build

```bash
npm install
npm run build
```

### Step 3: Run the Pipeline

```bash
npm run pipeline
```

That's it! The pipeline will:

1. ✓ Fetch hotel dump from WorldOTA
2. ✓ Download compressed file
3. ✓ Decompress and upload to S3
4. ✓ Stream from S3 and insert into PostgreSQL
5. ✓ Show you performance stats

## What Happens Step by Step

```
╔═════════════════════════════════════════════════╗
║  Step 0: Test DB Connection                     ║
║  ✓ PostgreSQL connection successful             ║
║  ✓ Hotels table ready                           ║
╚═════════════════════════════════════════════════╝

╔═════════════════════════════════════════════════╗
║  Step 1: Download from WorldOTA                 ║
║  ✓ Dump file downloaded: 2,345MB                ║
║  Time: 145.23s                                  ║
╚═════════════════════════════════════════════════╝

╔═════════════════════════════════════════════════╗
║  Step 2: Decompress & Upload to S3              ║
║  ✓ File uploaded to S3 (decompressed)           ║
║  Time: 52.10s                                   ║
╚═════════════════════════════════════════════════╝

╔═════════════════════════════════════════════════╗
║  Step 3: Stream from S3 → PostgreSQL            ║
║  Processed 250 batches                          ║
║  ✓ Streamed 50,000 records                      ║
║  Time: 312.45s                                  ║
╚═════════════════════════════════════════════════╝

Performance Summary:
  Download:     145.23s
  Decompress:   52.10s
  Database:     312.45s
  Total:        509.78s (8.5 minutes)

Data Summary:
  Total:        50,000
  Successful:   49,850
  Failed:       150
  Success:      99.70%
```

## Customization

### Change Batch Size

Edit `src/pipelines/usage.ts` and adjust:

```typescript
batchSize: 200, // Change this number
```

Larger = faster but uses more memory
Smaller = slower but uses less memory

### Keep Downloaded Files

To keep compressed and decompressed files locally:

```typescript
keepLocalFiles: true, // Change to true
```

### Change Inventory Type

```typescript
inventory: "direct", // Options: all, direct, preferable, direct_fast
```

## Monitoring Queries

Once data is loaded, query your hotels:

```sql
-- Total hotels
SELECT COUNT(*) FROM hotels;

-- Hotels by city
SELECT city, COUNT(*) FROM hotels GROUP BY city ORDER BY count DESC LIMIT 10;

-- Hotels by star rating
SELECT star_rating, COUNT(*) FROM hotels
GROUP BY star_rating
ORDER BY star_rating DESC;

-- Search by location
SELECT name, city, country, star_rating
FROM hotels
WHERE city ILIKE '%Paris%'
AND star_rating >= 4
ORDER BY star_rating DESC;
```

## Troubleshooting

### PostgreSQL Connection Error

```bash
# Test your PostgreSQL connection
psql -h localhost -U postgres -d hotel_sync

# If that works, check your .env file
cat .env | grep DB_
```

### S3 Upload Failed

```bash
# Verify AWS credentials
aws s3 ls

# Check bucket exists
aws s3 ls s3://your-bucket-name/
```

### Out of Memory

Reduce batch size in `src/pipelines/usage.ts`:

```typescript
batchSize: 50, // Much smaller
```

### Slow Database Inserts

The pipeline creates connection pool automatically. To adjust:

```typescript
postgresConfig: {
  // ... other config
  maxConnections: 50, // Increase from default 20
},
```

## Next Steps

1. Check out [README.md](README.md) for full documentation
2. Explore service files in `src/services/`
3. Customize the pipeline in `src/pipelines/hotelSyncPipeline.ts`
4. Add your own batch processing logic

## Support

Check logs for detailed error messages. All services include:

- ✓ Retry logic
- ✓ Error handling
- ✓ Detailed logging
- ✓ Progress tracking
