import HotelSyncPipeline from "./hotelSyncPipeline";

/**
 * Complete pipeline example: Download → Decompress to S3 → PostgreSQL
 *
 * Environment variables required:
 * - KEY_ID: WorldOTA API key ID
 * - API_KEY: WorldOTA API key
 * - AWS_REGION: S3 region (e.g., us-east-1)
 * - S3_BUCKET: S3 bucket name
 * - AWS_ACCESS_KEY_ID: AWS access key
 * - AWS_SECRET_ACCESS_KEY: AWS secret key
 * - DB_HOST: PostgreSQL host
 * - DB_PORT: PostgreSQL port (default 5432)
 * - DB_NAME: PostgreSQL database name
 * - DB_USER: PostgreSQL user
 * - DB_PASSWORD: PostgreSQL password
 */
async function main() {
  // Validate environment variables
  const requiredEnvVars = [
    "KEY_ID",
    "API_KEY",
    "AWS_REGION",
    "S3_BUCKET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "DB_HOST",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
  ];

  const missing = requiredEnvVars.filter((env) => !process.env[env]);
  if (missing.length > 0) {
    console.error(
      "✗ Missing required environment variables:",
      missing.join(", "),
    );
    process.exit(1);
  }

  const pipeline = new HotelSyncPipeline({
    // WorldOTA API credentials
    keyId: process.env.KEY_ID!,
    apiKey: process.env.API_KEY!,
    inventory: "all", // all | direct | preferable | direct_fast
    language: "en",
    downloadDir: "./downloads",

    // S3 configuration
    s3Config: {
      region: process.env.AWS_REGION!,
      bucket: process.env.S3_BUCKET!,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },

    // PostgreSQL configuration
    postgresConfig: {
      host: process.env.DB_HOST!,
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      database: process.env.DB_NAME!,
      user: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      maxConnections: 20,
      // Enable SSL for cloud databases (Aiven, AWS RDS, etc.)
      ssl:
        process.env.DB_SSL !== "false"
          ? {
              rejectUnauthorized: false, // For self-signed certificates
            }
          : false,
    },

    // Pipeline options
    batchSize: 200, // Process 200 records at a time
    keepLocalFiles: false, // Delete compressed file after S3 upload
  });

  try {
    const stats = await pipeline.run();

    console.log("\n✓ Pipeline execution successful!");
    console.log(
      `  Total time: ${(stats.totalTimeMs / 1000).toFixed(2)} seconds`,
    );
  } catch (error) {
    console.error("✗ Pipeline execution failed:", error);
    process.exit(1);
  } finally {
    await pipeline.close();
  }
}

main();
