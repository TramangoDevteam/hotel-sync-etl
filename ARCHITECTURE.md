# Architecture & Data Flow

## Complete Pipeline Overview

```
┌────────────────────────────────────────────────────────────────┐
│                    Hotel Sync Pipeline                          │
│                 (Automated Data Workflow)                       │
└────────────────────────────────────────────────────────────────┘

                            ↓

┌────────────────────────────────────────────────────────────────┐
│  STEP 1: Download from WorldOTA API                            │
│  ───────────────────────────────────────────────────────────   │
│  • Fetch hotel dump URL via API                                │
│  • Download compressed .zst file (2-5GB)                       │
│  • Verify SHA256 checksum                                      │
│  • Local storage: ./downloads/                                 │
│  ─────────────────────────────────────────────────────────────│
│  HotelDumpService.downloadDump()                               │
└──────────────────────┬───────────────────────────────────────┘
                       │
                  Compressed
                  .zst File
                       │
                       ↓

┌────────────────────────────────────────────────────────────────┐
│  STEP 2: Decompress to S3                                      │
│  ───────────────────────────────────────────────────────────   │
│  • Use zstd command-line to decompress                         │
│  • Stream decompressed data to S3                              │
│  • Uses AWS SDK Upload with progress tracking                  │
│  • S3 storage: s3://bucket/hotel_dump_*.jsonl                  │
│  ─────────────────────────────────────────────────────────────│
│  decompressStreamToS3()                                        │
└──────────────────────┬───────────────────────────────────────┘
                       │
                   JSONL Data
                       │
                       ↓

                   ┌──────────────┐
                   │  AWS S3      │
                   │  Bucket      │
                   │              │
                   │ hotel_dump   │
                   │ (JSONL)      │
                   └──────┬───────┘
                          │
                    Read in batches
                          │
                          ↓

┌────────────────────────────────────────────────────────────────┐
│  STEP 3: Stream & Parse from S3                                │
│  ───────────────────────────────────────────────────────────   │
│  • Read JSONL from S3 line-by-line                             │
│  • Batch process (default 100 records/batch)                   │
│  • Parse JSON, handle errors gracefully                        │
│  • Streaming: memory efficient (no full load)                  │
│  ─────────────────────────────────────────────────────────────│
│  streamHotelsFromS3()                                          │
└──────────────────────┬───────────────────────────────────────┘
                       │
                   Hotel Records
                   (Batched)
                       │
                       ↓

┌────────────────────────────────────────────────────────────────┐
│  STEP 4: Write to PostgreSQL                                   │
│  ───────────────────────────────────────────────────────────   │
│  • Connection pooling (default 20 connections)                 │
│  • Batch inserts using multi-row INSERT                        │
│  • UPSERT logic: update if exists, insert if new               │
│  • Index optimization for fast queries                         │
│  • Automatic table creation on first run                       │
│  ─────────────────────────────────────────────────────────────│
│  PostgresService.insertHotels()                                │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ↓

                ┌──────────────────┐
                │   PostgreSQL     │
                │   Database       │
                │                  │
                │   hotels table   │
                │   (50k+ records) │
                └──────────────────┘

```

## Service Architecture

### 1. HotelDumpService

**Purpose**: Download and decompress hotel data from WorldOTA API

```typescript
class HotelDumpService {
  // Public Methods
  fetchDumpUrl(); // Get download URL from API
  downloadDump(url); // Stream download with progress
  decompressDump(path); // Decompress .zst file
  parseDump(path); // Parse JSONL file
  uploadToS3(path); // Upload to S3 (optional)
  processHotelDump(); // Complete pipeline

  // Private Methods
  retry(); // Retry wrapper with exponential backoff
  ensureDownloadDir(); // Verify disk space & permissions
  checkDiskSpace(); // Check available space
  cleanup(); // Remove temporary files
}
```

**Usage**:

```typescript
const service = new HotelDumpService({
  keyId: process.env.KEY_ID,
  apiKey: process.env.API_KEY,
  downloadDir: "./downloads",
  maxRetries: 3,
  batchSize: 1000,
});

const { records, stats } = await service.processHotelDump();
```

### 2. PostgresService

**Purpose**: Manage PostgreSQL connections and data insertion

```typescript
class PostgresService {
  // Connection Management
  testConnection(); // Verify DB connection
  createHotelsTable(); // Create table structure
  close(); // Close connection pool

  // Data Operations
  insertHotels(records); // Batch insert with upsert
  insertHotelsBatch(); // Streaming batch insert
  getHotelCount(); // Query hotel count
  getHotel(id); // Get single hotel
  searchHotels(city); // Search by location
}
```

**Usage**:

```typescript
const db = new PostgresService({
  host: "localhost",
  port: 5432,
  database: "hotel_sync",
  user: "postgres",
  password: "password",
  maxConnections: 20,
});

await db.testConnection();
await db.createHotelsTable();
const stats = await db.insertHotels(records);
```

### 3. S3StreamService

**Purpose**: Handle S3 operations with streaming for large files

```typescript
// Standalone functions
decompressStreamToS3(
  compressedPath, // Local .zst file
  s3Config, // S3 credentials
  s3Key, // S3 file path (optional)
);

streamHotelsFromS3(
  s3Config, // S3 credentials
  s3Key, // S3 file path
  onBatch, // Callback for each batch
  batchSize, // Records per batch
);
```

**Usage**:

```typescript
// Decompress to S3
await decompressStreamToS3(
  "./hotel_dump.zst",
  {
    region: "us-east-1",
    bucket: "my-bucket",
    accessKeyId: "...",
    secretAccessKey: "...",
  },
  "hotel_dump.jsonl",
);

// Stream from S3
await streamHotelsFromS3(
  s3Config,
  "hotel_dump.jsonl",
  async (batch) => {
    console.log(`Processing ${batch.length} hotels`);
  },
  100,
);
```

### 4. HotelSyncPipeline

**Purpose**: Orchestrate the complete workflow

```typescript
class HotelSyncPipeline {
  constructor(config); // Initialize with all services
  run(); // Execute pipeline
  close(); // Clean up resources
}
```

**Usage**:

```typescript
const pipeline = new HotelSyncPipeline({
  keyId: "...",
  apiKey: "...",
  s3Config: { ... },
  postgresConfig: { ... },
  batchSize: 200,
  keepLocalFiles: false,
});

const stats = await pipeline.run();
```

## Data Flow Details

### File Conversions

```
WorldOTA API
    ↓
[.zst compressed]  ← 2-5 GB
    ↓ (Download)
Local disk
    ↓ (Decompress)
[.jsonl uncompressed] ← 10-20 GB
    ↓ (Stream to S3)
S3 bucket
    ↓ (Stream from S3)
Memory (batches)  ← 100-1000 records at a time
    ↓ (Insert)
PostgreSQL table
```

### Database Schema

```
hotels (table)
├── id (serial PK)
├── hotel_id (varchar unique) ← Used for UPSERT
├── name (varchar)
├── description (text)
├── location data
│   ├── country
│   ├── state
│   ├── city
│   ├── zip_code
│   ├── address
│   ├── latitude
│   └── longitude
├── contact data
│   ├── phone
│   ├── fax
│   ├── email
│   └── website
├── amenities
│   ├── check_in_time
│   ├── check_out_time
│   ├── images (array)
│   ├── amenities (array)
│   └── languages (array)
├── raw_data (JSONB) ← Complete original data
├── created_at (timestamp)
└── updated_at (timestamp)

Indexes:
├── hotel_id (unique)
├── city
├── country
├── star_rating
└── updated_at
```

## Error Handling Strategy

```
Operation → Try
    ↓
    ├→ Success? → Proceed
    │
    ├→ Temporary Error? → Retry with backoff
    │   (exponential: 1s, 2s, 4s, 8s...)
    │
    └→ Fatal Error? → Log & skip
        (partial batch continue)
```

## Performance Characteristics

| Operation  | Typical Time  | Depends On                   |
| ---------- | ------------- | ---------------------------- |
| Fetch URL  | 2-3s          | Network latency to API       |
| Download   | 2-5 min       | File size (2-5GB), bandwidth |
| Decompress | 30-60s        | Compression ratio, CPU       |
| S3 Upload  | 2-5 min       | Bandwidth to AWS             |
| DB Insert  | 5-15 min      | 50k records, batch size      |
| **Total**  | **15-30 min** | All above factors            |

## Resource Usage

| Resource    | Usage                                |
| ----------- | ------------------------------------ |
| Disk Space  | 25-30 GB (compressed + decompressed) |
| RAM         | 100-500 MB (batching)                |
| Network     | ~10 Mbps download, 5 Mbps upload     |
| CPU         | Low (I/O bound)                      |
| Connections | 20 concurrent (PostgreSQL pool)      |

## Scaling Considerations

### For Larger Datasets

```typescript
{
  batchSize: 500,              // Larger batches
  maxConnections: 50,          // More DB connections
  retryDelayMs: 2000,          // Longer retry delays
}
```

### For Smaller Resources

```typescript
{
  batchSize: 25,               // Smaller batches
  maxConnections: 5,           // Fewer connections
  keepLocalFiles: false,       // Delete after S3
}
```

### Parallel Runs (Not Recommended)

The pipeline automatically handles conflicts via UPSERT, but running
multiple instances simultaneously may cause:

- Database lock contention
- Duplicate processing
- Wasted bandwidth

Better approach: Run on schedule (daily, weekly)
