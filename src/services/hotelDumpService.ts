import "dotenv/config";
import axios, { AxiosError } from "axios";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import {
  createReadStream,
  createWriteStream,
  promises as fsPromises,
} from "fs";
import { createInterface } from "readline";
import {
  S3Client,
  PutObjectCommand,
  ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import * as crypto from "crypto";

// Use a proper zstd library
import { decompress } from "@mongodb-js/zstd";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface HotelDumpResponse {
  data: {
    url: string;
    last_update: string;
  };
  error: string | null;
  status: string;
}

interface HotelRecord {
  id?: string;
  name?: string;
  [key: string]: any;
}

interface DumpServiceConfig {
  keyId: string;
  apiKey: string;
  inventory?: "all" | "direct" | "preferable" | "direct_fast";
  language?: string;
  downloadDir?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  batchSize?: number;
  s3Config?: {
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    serverSideEncryption?: string;
  };
}

interface ProcessingStats {
  totalRecords: number;
  successfulRecords: number;
  failedRecords: number;
  downloadSizeBytes: number;
  processingTimeMs: number;
}

class HotelDumpService {
  private config: Required<Omit<DumpServiceConfig, "s3Config">> & {
    s3Config?: DumpServiceConfig["s3Config"];
  };
  private apiBaseUrl = "https://api.worldota.net/api/b2b/v3";
  private s3Client?: S3Client;

  constructor(config: DumpServiceConfig) {
    // Validate required config
    if (!config.keyId || !config.apiKey) {
      throw new Error("keyId and apiKey are required");
    }

    this.config = {
      inventory: "all",
      language: "en",
      downloadDir: "./downloads",
      maxRetries: 3,
      retryDelayMs: 1000,
      batchSize: 1000,
      ...config,
    };

    // Validate S3 config if provided
    if (this.config.s3Config) {
      const { region, bucket, accessKeyId, secretAccessKey } =
        this.config.s3Config;
      if (!region || !bucket || !accessKeyId || !secretAccessKey) {
        throw new Error(
          "S3 config requires region, bucket, accessKeyId, and secretAccessKey",
        );
      }

      this.s3Client = new S3Client({
        region: this.config.s3Config.region,
        credentials: {
          accessKeyId: this.config.s3Config.accessKeyId,
          secretAccessKey: this.config.s3Config.secretAccessKey,
        },
      });
    }
  }

  /**
   * Ensure download directory exists with proper permissions
   */
  private async ensureDownloadDir(): Promise<void> {
    try {
      await fsPromises.mkdir(this.config.downloadDir, { recursive: true });
      // Check write permissions
      await fsPromises.access(this.config.downloadDir, fs.constants.W_OK);
    } catch (error) {
      throw new Error(
        `Cannot create or write to download directory: ${this.config.downloadDir}`,
      );
    }
  }

  /**
   * Check available disk space
   */
  private async checkDiskSpace(requiredBytes: number = 1e9): Promise<void> {
    try {
      const stats = await fsPromises.statfs(this.config.downloadDir);
      const availableBytes = stats.bavail * stats.bsize;

      if (availableBytes < requiredBytes) {
        throw new Error(
          `Insufficient disk space. Available: ${(availableBytes / 1e9).toFixed(2)}GB, Required: ~${(requiredBytes / 1e9).toFixed(2)}GB`,
        );
      }
    } catch (error: any) {
      if (error.code === "ENOSYS") {
        console.warn("⚠ Cannot check disk space on this system");
      } else {
        throw error;
      }
    }
  }

  /**
   * Retry wrapper for async operations
   */
  private async retry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        console.warn(
          `⚠ ${operationName} failed (attempt ${attempt}/${this.config.maxRetries}):`,
          error instanceof Error ? error.message : error,
        );

        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
          console.log(`  Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `${operationName} failed after ${this.config.maxRetries} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Fetch the hotel dump URL and metadata with retry logic
   */
  async fetchDumpUrl(): Promise<HotelDumpResponse> {
    return this.retry(async () => {
      console.log("Fetching hotel dump URL...");

      const response = await axios.post<HotelDumpResponse>(
        `${this.apiBaseUrl}/hotel/info/dump/`,
        {
          inventory: this.config.inventory,
          language: this.config.language,
        },
        {
          auth: {
            username: this.config.keyId,
            password: this.config.apiKey,
          },
          headers: {
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );

      if (!response.data?.data?.url) {
        throw new Error("Invalid response: missing dump URL");
      }

      console.log(`✓ Dump URL fetched successfully`);
      console.log(`  Last update: ${response.data.data.last_update}`);
      console.log(`  URL: ${response.data.data.url}`);

      return response.data;
    }, "Fetch dump URL");
  }

  /**
   * Check if a recent compressed dump file exists (within 48 hours)
   */
  private async getRecentDumpFile(): Promise<string | null> {
    try {
      const files = await fsPromises.readdir(this.config.downloadDir);
      const zstFiles = files
        .filter((f) => f.endsWith(".jsonl.zst"))
        .sort()
        .reverse();

      if (zstFiles.length === 0) return null;

      const filePath = path.join(this.config.downloadDir, zstFiles[0]);
      const stats = await fsPromises.stat(filePath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

      if (ageHours < 48) {
        console.log(
          `✓ Found recent dump file: ${zstFiles[0]} (${ageHours.toFixed(1)} hours old)`,
        );
        return filePath;
      }
    } catch (error) {
      // Ignore errors, will download fresh
    }
    return null;
  }

  /**
   * Download the Zstd compressed dump file with progress and checksum
   */
  async downloadDump(url: string): Promise<string> {
    await this.ensureDownloadDir();

    // Check if recent file exists
    const recentFile = await this.getRecentDumpFile();
    if (recentFile) {
      console.log(`Using cached dump file instead of downloading`);
      return recentFile;
    }

    await this.checkDiskSpace();

    return this.retry(async () => {
      return new Promise<string>((resolve, reject) => {
        const fileName = `hotel_dump_${Date.now()}.jsonl.zst`;
        const filePath = path.join(this.config.downloadDir, fileName);
        const tempPath = `${filePath}.tmp`;

        console.log(`Downloading dump file...`);

        const file = createWriteStream(tempPath);
        const hash = crypto.createHash("sha256");
        let downloadedBytes = 0;
        let lastProgressUpdate = Date.now();

        https
          .get(url, (response) => {
            if (response.statusCode !== 200) {
              reject(
                new Error(
                  `Download failed with status: ${response.statusCode}`,
                ),
              );
              return;
            }

            const totalBytes = parseInt(
              response.headers["content-length"] || "0",
              10,
            );

            response.on("data", (chunk) => {
              downloadedBytes += chunk.length;
              hash.update(chunk);

              // Progress update every 5 seconds
              const now = Date.now();
              if (now - lastProgressUpdate > 5000) {
                const progress = totalBytes
                  ? ((downloadedBytes / totalBytes) * 100).toFixed(1)
                  : downloadedBytes;
                console.log(
                  `  Progress: ${typeof progress === "string" && totalBytes ? progress + "%" : (downloadedBytes / 1e6).toFixed(2) + "MB"}`,
                );
                lastProgressUpdate = now;
              }
            });

            response.pipe(file);

            file.on("finish", () => {
              file.close(async () => {
                // Rename temp file to final file
                try {
                  await fsPromises.rename(tempPath, filePath);
                  const checksum = hash.digest("hex");
                  console.log(
                    `✓ Dump file downloaded: ${filePath} (${(downloadedBytes / 1e6).toFixed(2)}MB)`,
                  );
                  console.log(`  SHA256: ${checksum}`);
                  resolve(filePath);
                } catch (error) {
                  reject(error);
                }
              });
            });
          })
          .on("error", async (error) => {
            // Clean up temp file
            try {
              await fsPromises.unlink(tempPath);
            } catch {}
            console.error("✗ Error downloading dump:", error);
            reject(error);
          });

        file.on("error", async (error) => {
          try {
            await fsPromises.unlink(tempPath);
          } catch {}
          reject(error);
        });
      });
    }, "Download dump");
  }

  /**
   * Decompress Zstd file using proper library
   */
  async decompressDump(compressedPath: string): Promise<string> {
    return this.retry(async () => {
      const decompressedPath = compressedPath.replace(".zst", "");
      console.log(`Decompressing dump file...`);

      try {
        // Use native zstd command (much faster and more reliable for large files)
        await execAsync(`zstd -d "${compressedPath}" -o "${decompressedPath}"`);

        const stats = await fsPromises.stat(decompressedPath);
        console.log(`✓ Dump file decompressed: ${decompressedPath}`);
        console.log(`  Decompressed size: ${(stats.size / 1e6).toFixed(2)}MB`);

        return decompressedPath;
      } catch (error) {
        console.error("✗ Error decompressing dump:", error);
        throw error;
      }
    }, "Decompress dump");
  }

  /**
   * Stream parse JSONL dump file with batching and error handling
   */
  async parseDump(
    filePath: string,
    onBatch?: (batch: HotelRecord[]) => Promise<void>,
  ): Promise<HotelRecord[]> {
    // Use async-iterator (for await…of) so each line is fully awaited before
    // the next one fires — avoids the readline "async handler not awaited" race.
    const allRecords: HotelRecord[] = [];
    let currentBatch: HotelRecord[] = [];
    let lineCount = 0;
    let successCount = 0;
    let errorCount = 0;

    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

    const processBatch = async () => {
      if (currentBatch.length === 0) return;
      if (onBatch) {
        try {
          await onBatch([...currentBatch]);
        } catch (error) {
          console.error("✗ Error processing batch:", error);
        }
      } else {
        allRecords.push(...currentBatch);
      }
      currentBatch = [];
    };

    try {
      for await (const line of rl) {
        lineCount++;
        try {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let cleanedLine = trimmed;
          if (cleanedLine.endsWith(",")) cleanedLine = cleanedLine.slice(0, -1);

          if (cleanedLine.startsWith("{")) {
            const record = JSON.parse(cleanedLine) as HotelRecord;
            currentBatch.push(record);
            successCount++;

            if (currentBatch.length >= this.config.batchSize) {
              await processBatch();
            }
          }
        } catch (error) {
          errorCount++;
          if (errorCount <= 10) {
            console.warn(
              `⚠ Warning: Failed to parse line ${lineCount}:`,
              error instanceof Error ? error.message : error,
            );
            console.warn(`  Line content: ${line.substring(0, 100)}...`);
          } else if (errorCount === 11) {
            console.warn("⚠ Suppressing further parse warnings...");
          }
        }
      }
    } finally {
      // Process any remaining records after the file ends
      await processBatch();
    }

    console.log(`✓ Parsed ${successCount} hotel records`);
    if (errorCount > 0) console.warn(`⚠ Skipped ${errorCount} invalid lines`);

    return allRecords;
  }

  /**
   * Upload decompressed dump to S3 with streaming
   */
  async uploadToS3(filePath: string, key?: string): Promise<void> {
    if (!this.s3Client || !this.config.s3Config) {
      throw new Error("S3 configuration not provided");
    }

    return this.retry(async () => {
      try {
        const fileName = key || path.basename(filePath);
        const fileStats = await fsPromises.stat(filePath);

        console.log(
          `Uploading to S3 bucket: ${this.config.s3Config!.bucket} (${(fileStats.size / 1e6).toFixed(2)}MB)`,
        );

        const fileStream = createReadStream(filePath);

        const upload = new Upload({
          client: this.s3Client!,
          params: {
            Bucket: this.config.s3Config!.bucket,
            Key: fileName,
            Body: fileStream,
            ContentType: "application/x-jsonl",
            ServerSideEncryption:
              (this.config.s3Config!
                .serverSideEncryption as ServerSideEncryption) ||
              ServerSideEncryption.AES256,
          },
        });

        upload.on("httpUploadProgress", (progress) => {
          if (progress.loaded && progress.total) {
            const percent = ((progress.loaded / progress.total) * 100).toFixed(
              1,
            );
            console.log(`  Upload progress: ${percent}%`);
          }
        });

        await upload.done();

        console.log(
          `✓ File uploaded to S3: s3://${this.config.s3Config!.bucket}/${fileName}`,
        );
      } catch (error) {
        console.error("✗ Error uploading to S3:", error);
        throw error;
      }
    }, "Upload to S3");
  }

  /**
   * Clean up temporary files
   */
  private async cleanup(filePaths: string[]): Promise<void> {
    console.log("Cleaning up temporary files...");
    for (const filePath of filePaths) {
      try {
        await fsPromises.unlink(filePath);
        console.log(`  ✓ Deleted: ${filePath}`);
      } catch (error) {
        console.warn(`  ⚠ Could not delete: ${filePath}`);
      }
    }
  }

  /**
   * Full pipeline: fetch, download, decompress, parse, and optionally upload to S3
   */
  async processHotelDump(
    options: {
      uploadToS3?: boolean;
      keepFiles?: boolean;
      onBatch?: (batch: HotelRecord[]) => Promise<void>;
    } = {},
  ): Promise<{ records: HotelRecord[]; stats: ProcessingStats }> {
    const startTime = Date.now();
    const filesToCleanup: string[] = [];

    try {
      console.log("\n=== Starting Hotel Dump Processing ===\n");

      // Fetch dump URL
      const dumpResponse = await this.fetchDumpUrl();
      const dumpUrl = dumpResponse.data.url;

      // Download dump
      const compressedPath = await this.downloadDump(dumpUrl);
      filesToCleanup.push(compressedPath);

      const compressedStats = await fsPromises.stat(compressedPath);

      // Decompress dump
      const decompressedPath = await this.decompressDump(compressedPath);
      if (!options.keepFiles) {
        filesToCleanup.push(decompressedPath);
      }

      // Parse dump
      const hotelRecords = await this.parseDump(
        decompressedPath,
        options.onBatch,
      );

      // Upload to S3 if configured
      if (options.uploadToS3 && this.s3Client) {
        await this.uploadToS3(decompressedPath);
      }

      const stats: ProcessingStats = {
        totalRecords: hotelRecords.length,
        successfulRecords: hotelRecords.length,
        failedRecords: 0,
        downloadSizeBytes: compressedStats.size,
        processingTimeMs: Date.now() - startTime,
      };

      console.log("\n=== Hotel Dump Processing Complete ===");
      console.log(`  Records processed: ${stats.totalRecords}`);
      console.log(
        `  Processing time: ${(stats.processingTimeMs / 1000).toFixed(2)}s`,
      );
      console.log("");

      return { records: hotelRecords, stats };
    } catch (error) {
      console.error("\n✗ Hotel dump processing failed:", error);
      throw error;
    } finally {
      // Always cleanup unless keepFiles is true
      if (!options.keepFiles && filesToCleanup.length > 0) {
        await this.cleanup(filesToCleanup);
      }
    }
  }
}

export default HotelDumpService;
export { HotelDumpService, HotelRecord, DumpServiceConfig, ProcessingStats };
