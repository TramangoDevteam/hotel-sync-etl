import HotelDumpService from "../services/hotelDumpService";
import PostgresService from "../services/postgresService";
import {
  decompressStreamToS3,
  streamHotelsFromS3,
  getRecentS3File,
  S3StreamConfig,
} from "../services/s3StreamService";

interface PipelineConfig {
  // Dump service config
  keyId: string;
  apiKey: string;
  downloadDir?: string;
  inventory?: "all" | "direct" | "preferable" | "direct_fast";
  language?: string;

  // S3 config
  s3Config: {
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };

  // PostgreSQL config
  postgresConfig: {
    host: string;
    port?: number;
    database: string;
    user: string;
    password: string;
    maxConnections?: number;
    ssl?:
      | boolean
      | {
          rejectUnauthorized?: boolean;
          ca?: string;
          key?: string;
          cert?: string;
        };
  };

  // Pipeline options
  batchSize?: number;
  keepLocalFiles?: boolean; // Keep compressed and decompressed files
}

interface PipelineStats {
  downloadTimeMs: number;
  decompressTimeMs: number;
  s3UploadTimeMs: number;
  databaseInsertTimeMs: number;
  totalTimeMs: number;
  totalRecords: number;
  successfulRecords: number;
  failedRecords: number;
}

class HotelSyncPipeline {
  private dumpService: HotelDumpService;
  private postgresService: PostgresService;
  private s3Config: S3StreamConfig;
  private config: PipelineConfig;

  constructor(config: PipelineConfig) {
    // Validate required config
    if (
      !config.keyId ||
      !config.apiKey ||
      !config.s3Config ||
      !config.postgresConfig
    ) {
      throw new Error(
        "Missing required configuration: keyId, apiKey, s3Config, postgresConfig",
      );
    }

    this.config = {
      inventory: "all",
      language: "en",
      downloadDir: "./downloads",
      batchSize: 100,
      keepLocalFiles: false,
      ...config,
    };

    // Initialize services
    this.dumpService = new HotelDumpService({
      keyId: this.config.keyId,
      apiKey: this.config.apiKey,
      inventory: this.config.inventory,
      language: this.config.language,
      downloadDir: this.config.downloadDir,
    });

    this.postgresService = new PostgresService(this.config.postgresConfig);

    this.s3Config = this.config.s3Config;

    // Graceful shutdown: close the DB pool on SIGINT / SIGTERM so connections
    // are not left dangling when the process is killed or interrupted.
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received — closing DB pool...`);
      await this.postgresService.close().catch(() => {});
      process.exit(0);
    };
    process.once("SIGINT",  () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  }

  /**
   * Run the complete pipeline: Download → Decompress to S3 → Write to PostgreSQL
   */
  async run(): Promise<PipelineStats> {
    const pipelineStartTime = Date.now();
    const stats: PipelineStats = {
      downloadTimeMs: 0,
      decompressTimeMs: 0,
      s3UploadTimeMs: 0,
      databaseInsertTimeMs: 0,
      totalTimeMs: 0,
      totalRecords: 0,
      successfulRecords: 0,
      failedRecords: 0,
    };

    let compressedPath: string | null = null;
    let s3Key: string | null = null;
    const filesToCleanup: string[] = [];

    try {
      console.log(
        "\n╔═══════════════════════════════════════════════════════╗",
      );
      console.log("║     Hotel Sync Pipeline - Download to PostgreSQL      ║");
      console.log(
        "╚═══════════════════════════════════════════════════════╝\n",
      );

      // Step 0: Test database connection and create schema
      console.log("Step 0: Testing database connection...");
      await this.postgresService.testConnection();
      await this.postgresService.createSchema();

      // Step 1: Check if recent file exists in S3, otherwise fetch and download
      console.log("\nStep 1: Checking for recent decompressed file in S3...");
      s3Key = await getRecentS3File(this.s3Config, 48);

      if (s3Key) {
        console.log(`Using cached file in S3: ${s3Key}`);
        console.log(`  Time: 0.00s\n`);
      } else {
        console.log("No recent file found in S3, fetching and downloading...");
        const downloadStart = Date.now();

        const dumpResponse = await this.dumpService.fetchDumpUrl();
        compressedPath = await this.dumpService.downloadDump(
          dumpResponse.data.url,
        );
        filesToCleanup.push(compressedPath);

        stats.downloadTimeMs = Date.now() - downloadStart;
        console.log(`  Time: ${(stats.downloadTimeMs / 1000).toFixed(2)}s\n`);

        // Step 2: Decompress to S3
        console.log("Step 2: Decompressing and uploading to S3...");
        const decompressStart = Date.now();

        s3Key = `hotel_dump_${Date.now()}.jsonl`;
        await decompressStreamToS3(compressedPath, this.s3Config, s3Key);

        stats.decompressTimeMs = Date.now() - decompressStart;
        console.log(`  Time: ${(stats.decompressTimeMs / 1000).toFixed(2)}s\n`);
      }

      // Verify s3Key exists
      if (!s3Key) {
        throw new Error("Failed to obtain S3 file key");
      }

      // Step 3: Stream from S3 and insert into PostgreSQL
      console.log(
        "Step 3: Streaming from S3 and inserting into PostgreSQL...\n",
      );
      const dbInsertStart = Date.now();

      let totalBatches = 0;
      await streamHotelsFromS3(
        this.s3Config,
        s3Key,
        async (batch) => {
          const insertStats = await this.postgresService.insertHotels(batch, {
            upsert: true,
            batchSize: this.config.batchSize || 100,
          });

          stats.totalRecords += insertStats.totalRecords;
          stats.successfulRecords += insertStats.successfulInserts;
          stats.failedRecords += insertStats.failedInserts;

          totalBatches++;
          if (totalBatches % 10 === 0) {
            console.log(
              `  Processed ${totalBatches} batches (${stats.successfulRecords} records)`,
            );
          }
        },
        this.config.batchSize || 100,
      );

      stats.databaseInsertTimeMs = Date.now() - dbInsertStart;
      stats.totalTimeMs = Date.now() - pipelineStartTime;

      // Print summary
      console.log(
        "\n╔═══════════════════════════════════════════════════════╗",
      );
      console.log("║              Pipeline Complete ✓                       ║");
      console.log(
        "╚═══════════════════════════════════════════════════════╝\n",
      );

      console.log("Performance Summary:");
      console.log(
        `  Download:        ${(stats.downloadTimeMs / 1000).toFixed(2)}s`,
      );
      console.log(
        `  Decompress+S3:   ${(stats.decompressTimeMs / 1000).toFixed(2)}s`,
      );
      console.log(
        `  DB Insert:       ${(stats.databaseInsertTimeMs / 1000).toFixed(2)}s`,
      );
      console.log(
        `  Total:           ${(stats.totalTimeMs / 1000).toFixed(2)}s\n`,
      );

      console.log("Data Summary:");
      console.log(`  Total Records:   ${stats.totalRecords}`);
      console.log(`  Successful:      ${stats.successfulRecords}`);
      console.log(`  Failed:          ${stats.failedRecords}`);
      console.log(
        `  Success Rate:    ${(
          (stats.successfulRecords / stats.totalRecords) *
          100
        ).toFixed(2)}%\n`,
      );

      // Get final count from database
      const finalCount = await this.postgresService.getHotelCount();
      console.log(`  Hotels in DB:    ${finalCount}\n`);

      return stats;
    } catch (error) {
      console.error("\n✗ Pipeline failed:", error);
      throw error;
    } finally {
      // Cleanup
      if (!this.config.keepLocalFiles && filesToCleanup.length > 0) {
        console.log("Cleaning up temporary files...");
        const { promises: fsp } = await import("fs");
        for (const fp of filesToCleanup) {
          try {
            await fsp.unlink(fp);
            console.log(`  ✓ Deleted: ${fp}`);
          } catch {
            console.warn(`  ⚠ Could not delete: ${fp}`);
          }
        }
      }

      // Close database connection
      await this.postgresService.close();
    }
  }

  /**
   * Close services gracefully
   */
  async close(): Promise<void> {
    await this.postgresService.close();
  }
}

export default HotelSyncPipeline;
export { HotelSyncPipeline, PipelineConfig, PipelineStats };
