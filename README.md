# 🚀 Hotel Stream-ETL

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?style=flat-square&logo=node.js)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)](tsconfig.json)
[![GitHub stars](https://img.shields.io/github/stars/TramangoDevteam/hotel-stream-etl?style=flat-square&logo=github)](https://github.com/TramangoDevteam/hotel-stream-etl)
[![GitHub issues](https://img.shields.io/github/issues/TramangoDevteam/hotel-stream-etl?style=flat-square&logo=github)](https://github.com/TramangoDevteam/hotel-stream-etl/issues)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-13%2B-336791?style=flat-square&logo=postgresql)](https://www.postgresql.org)

**Zero-disk ETL pipeline for streaming massive datasets directly from compressed sources to PostgreSQL via AWS S3**

Stream 40GB+ compressed data without ever writing decompressed files to disk. Built for scale, designed for cost-efficiency.

---

## 🎯 The Problem We Solve

Traditional ETL pipelines for large datasets:

```
Download (2.7GB) → Decompress to Disk (40GB) → Upload to S3 → Insert to DB
❌ Disk Space Exhausted
❌ Network Saturated
❌ Slow & Expensive
```

Hotel Stream-ETL:

```
Download → Decompress (Memory Only) → S3 → PostgreSQL
✅ Zero Intermediate Disk Writes
✅ 196+ Records/Sec
✅ <500MB Memory
✅ Production-Ready
```

---

## ⚡ Quick Stats

| Metric                  | Value                    |
| ----------------------- | ------------------------ |
| **Test Dataset**        | 40GB (2.7GB compressed)  |
| **Memory Used**         | <500MB                   |
| **Insert Rate**         | 196 records/sec          |
| **Total Time**          | 1,049 seconds (17.5 min) |
| **Success Rate**        | 100%                     |
| **Disk Space Required** | 0 bytes\*                |

\*Database storage only

---

## 📊 How It Works

```
┌────────────────────────┐
│  Compressed Source     │
│  (2.7GB zstd file)     │
└───────────┬────────────┘
            │ Stream download
            ▼
┌────────────────────────┐
│  S3 Multipart Upload   │
│  (No disk intermediate)│
└───────────┬────────────┘
            │ Decompress + Stream
            ▼
┌────────────────────────┐
│  PostgreSQL Insert     │
│  (Batch UPSERT)        │
│  196 records/sec       │
└────────────────────────┘
```

---

## 🚀 Features

- ✅ **Pure Streaming** - No decompressed files on disk
- ✅ **High Throughput** - 196+ records/sec insert rate
- ✅ **Memory Efficient** - Peak usage <500MB
- ✅ **Type Safe** - Full TypeScript, strict mode
- ✅ **S3 Integration** - AWS SDK v3, multipart uploads
- ✅ **Connection Pooling** - Optimized PostgreSQL access
- ✅ **Real-time Monitoring** - CLI dashboard with stats
- ✅ **Error Handling** - Retry logic with backoff
- ✅ **SSL/TLS Support** - Secure database connections
- ✅ **Caching** - Skip downloads for recent files
- ✅ **Production Ready** - Comprehensive logging

---

## 📦 Installation

### Prerequisites

- Node.js 18+
- PostgreSQL 13+
- AWS Account (S3 access)

### Setup

```bash
# Clone repository
git clone https://github.com/yourusername/stream-etl.git
cd stream-etl

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Build
npm run build

# Run
npm run pipeline

# Monitor (in another terminal)
npm run monitor
```

---

## 🔧 Configuration

Create `.env` file:

```env
# Data Source
KEY_ID=your_api_key_id
API_KEY=your_api_key

# AWS S3
AWS_REGION=us-east-1
S3_BUCKET=your-bucket-name
AWS_ACCESS_KEY_ID=***
AWS_SECRET_ACCESS_KEY=***

# PostgreSQL
DB_HOST=your-db-host
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_user
DB_PASSWORD=***
```

---

## 📖 Documentation

- [📋 Architecture Guide](docs/ARCHITECTURE.md)
- [🚀 Quick Start](docs/QUICKSTART.md)
- [🔧 API Reference](docs/API.md)
- [🐛 Troubleshooting](docs/TROUBLESHOOTING.md)
- [🤝 Contributing](CONTRIBUTING.md)
- [📜 License](LICENSE)

---

## 💻 Usage

### Full Pipeline

```bash
npm run pipeline
```

Downloads → Decompresses → Uploads to S3 → Inserts to PostgreSQL

### Monitor Dashboard

```bash
npm run monitor
```

Real-time statistics and progress

### Build Only

```bash
npm run build
```

### Type Check

```bash
npm run type-check
```

---

## 🏗️ Tech Stack

| Component       | Technology                |
| --------------- | ------------------------- |
| **Language**    | TypeScript 5.0            |
| **Runtime**     | Node.js 18+               |
| **Cloud**       | AWS S3                    |
| **Database**    | PostgreSQL 13+            |
| **Streaming**   | Node.js Transform streams |
| **Compression** | zstd                      |

---

## 📝 Real-World Example

```
╔══════════════════════════════════════════════════════════╗
║     Stream-ETL: Hotel Data Sync Pipeline                ║
╚══════════════════════════════════════════════════════════╝

Step 0: Testing database connection...
✓ PostgreSQL connection successful

Step 1: Checking for recent file...
✓ Found recent S3 file (0.0 hours old)

Step 2: (Skipped - using cached)

Step 3: Streaming from S3 and inserting...
✓ Processed 530 batches (106,000 records)

Performance Summary:
  Insert time: 542.18s
  Insert rate: 196 records/sec
  Success rate: 100% (0 failed)
  Total time: 1589.88s
```

---

## 🎯 When to Use

✅ **Good for:**

- One-time or infrequent data syncs
- Fixed-size datasets (GBs to TBs)
- Constrained disk environments
- Node.js infrastructure
- Budget-conscious operations

❌ **Consider alternatives for:**

- Complex multi-step transformations → Apache Spark
- Mission-critical recurring ETL → Apache Airflow
- Multi-source orchestration → AWS Glue
- Real-time streaming → Kafka/Flink

---

## 🐛 Troubleshooting

**No records inserted?**

```bash
SELECT COUNT(*) FROM hotels;
```

**Connection timeout?**

```bash
# Verify database connectivity
telnet your-db-host 5432
```

**S3 upload stalled?**

```bash
# Check S3 bucket access
aws s3 ls s3://your-bucket/
```

See [Troubleshooting Guide](docs/TROUBLESHOOTING.md) for more.

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Code standards
- Development setup
- Pull request process
- Reporting issues

**Quick start:**

```bash
git checkout -b feature/your-feature
npm run build
npm run test
git push origin feature/your-feature
# Open PR
```

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details

---

## 📞 Support

- **Issues** → [GitHub Issues](https://github.com/yourusername/stream-etl/issues)
- **Discussions** → [GitHub Discussions](https://github.com/yourusername/stream-etl/discussions)
- **Email** → dev@yourdomain.com

---

## ⭐ Recognition

If Stream-ETL helped you, please give us a star!

[![GitHub stars](https://img.shields.io/github/stars/yourusername/stream-etl?style=social)](https://github.com/yourusername/stream-etl)

---

## 📚 Articles & Case Studies

- [Building a Zero-Disk ETL Pipeline](blog.md)
- [Why We Didn't Use Apache Airflow for This](blog.md)

---

**Made with ❤️ for data engineers who care about performance**

### 3. Configure AWS S3

Set up S3 credentials in `.env`:

```env
AWS_REGION=us-east-1
S3_BUCKET=your-bucket-name
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
```

### 4. Configure WorldOTA API

Add your WorldOTA API credentials in `.env`:

```env
KEY_ID=your_api_key_id
API_KEY=your_api_key
```

## Complete `.env` Example

```env
# WorldOTA API
KEY_ID=your_key_id
API_KEY=your_api_key

# AWS S3
AWS_REGION=us-east-1
S3_BUCKET=hotel-dumps
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=hotel_sync
DB_USER=postgres
DB_PASSWORD=your_password
```

## Usage

### Run the Complete Pipeline

```bash
npm run build
npm start
```

Or with TypeScript directly:

```bash
npx ts-node src/pipelines/usage.ts
```

### Usage in Code

```typescript
import HotelSyncPipeline from "./pipelines/hotelSyncPipeline";

const pipeline = new HotelSyncPipeline({
  keyId: process.env.KEY_ID!,
  apiKey: process.env.API_KEY!,
  s3Config: {
    region: process.env.AWS_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  postgresConfig: {
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME!,
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
  },
  batchSize: 200,
  keepLocalFiles: false,
});

const stats = await pipeline.run();
console.log(stats);
```

## Service Architecture

### HotelDumpService

Handles downloading and decompressing hotel dumps from WorldOTA.

```typescript
const service = new HotelDumpService({
  keyId: "your_key",
  apiKey: "your_api_key",
  downloadDir: "./downloads",
  maxRetries: 3,
});

const { records, stats } = await service.processHotelDump();
```

### PostgresService

Manages PostgreSQL connections and inserts.

```typescript
const db = new PostgresService({
  host: "localhost",
  port: 5432,
  database: "hotel_sync",
  user: "postgres",
  password: "password",
});

await db.testConnection();
await db.createHotelsTable();
await db.insertHotels(records, { upsert: true });
```

### S3StreamService

Handles S3 operations and streaming.

```typescript
// Decompress directly to S3
await decompressStreamToS3(compressedPath, s3Config, "hotels.jsonl");

// Stream from S3 with batching
await streamHotelsFromS3(s3Config, "hotels.jsonl", async (batch) => {
  console.log(`Processing batch of ${batch.length}`);
});
```

### HotelSyncPipeline

Orchestrates the complete workflow.

```typescript
const pipeline = new HotelSyncPipeline(config);
const stats = await pipeline.run();
```

## Database Schema

The pipeline creates a `hotels` table with the following structure:

```sql
CREATE TABLE hotels (
  id SERIAL PRIMARY KEY,
  hotel_id VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(500),
  description TEXT,
  country VARCHAR(255),
  state VARCHAR(255),
  city VARCHAR(255),
  zip_code VARCHAR(20),
  address VARCHAR(500),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  star_rating DECIMAL(2, 1),
  phone VARCHAR(20),
  fax VARCHAR(20),
  website VARCHAR(500),
  email VARCHAR(255),
  check_in_time VARCHAR(10),
  check_out_time VARCHAR(10),
  images TEXT[],
  amenities TEXT[],
  languages TEXT[],
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Indexes are created on:

- `hotel_id` (unique)
- `city`
- `country`
- `star_rating`
- `updated_at`

## Performance Tips

1. **Batch Size**: Adjust `batchSize` based on memory and network:
   - Small machines: 50-100
   - Normal machines: 200-500
   - Large machines: 1000+

2. **Database Connection Pool**: Increase `maxConnections` for faster inserts (default 20)

3. **AWS Region**: Use the same region as your database if possible to reduce latency

4. **Disk Space**: Ensure at least 5GB free space for download/decompression

## Monitoring & Debugging

The pipeline provides detailed logs:

```
Step 0: Testing database connection...
✓ PostgreSQL connection successful: 2024-02-05 12:00:00
✓ Hotels table ready

Step 1: Fetching and downloading dump file...
Downloading dump file...
  Progress: 45.2%
✓ Dump file downloaded: ./downloads/hotel_dump_1770163443318.jsonl.zst (2345.67MB)

Step 2: Decompressing and uploading to S3...
Decompressing and uploading to S3...
  Upload progress: 78.3%
✓ File decompressed and uploaded to S3: s3://bucket/hotel_dump_1770163443318.jsonl

Step 3: Streaming from S3 and inserting into PostgreSQL...
  Inserted: 1000 records
  Inserted: 2000 records
✓ Streamed 50000 hotel records from S3

Performance Summary:
  Download:        120.45s
  Decompress+S3:   45.20s
  DB Insert:       180.30s
  Total:           345.95s

Data Summary:
  Total Records:   50000
  Successful:      49850
  Failed:          150
  Success Rate:    99.70%
```

## Troubleshooting

### Connection Refused

- Check PostgreSQL is running: `psql -h localhost`
- Verify credentials in `.env`

### S3 Upload Failed

- Verify AWS credentials
- Check bucket exists and is accessible
- Ensure region is correct

### Out of Memory

- Reduce `batchSize`
- Check available system memory
- Close other applications

### Slow Database Inserts

- Increase `maxConnections` in PostgreSQL config
- Check database disk space
- Verify network latency to database

## License

MIT
