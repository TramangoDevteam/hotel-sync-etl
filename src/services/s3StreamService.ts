import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { createReadStream, createWriteStream } from "fs";
import { Transform, pipeline } from "stream";
import { promisify } from "util";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { exec } from "child_process";

// For decompression
const execAsync = promisify(exec);

interface S3StreamConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Decompresses a Zstd stream and writes directly to S3
 * Pure streaming - no disk storage at all
 * Pipes: Compressed File → zstd decompress → S3 Upload
 */
async function decompressStreamToS3(
  compressedPath: string,
  s3Config: S3StreamConfig,
  s3Key?: string,
): Promise<void> {
  const fileName = s3Key || `hotel_dump_${Date.now()}.jsonl`;

  try {
    console.log(`Decompressing and streaming to S3...`);

    const s3Client = new S3Client({
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    });

    const { spawn } = require("child_process");
    const { PassThrough } = require("stream");

    // Create readable stream from compressed file
    const compressedStream = createReadStream(compressedPath, {
      highWaterMark: 64 * 1024,
    });

    // Spawn zstd decompression process
    const decompressProcess = spawn("zstd", ["-d", "-", "--threads=0"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let decompressedBytes = 0;
    let lastProgressUpdate = Date.now();
    let dataFlowing = false;

    // Create a PassThrough stream to track data flow and progress
    const trackingStream = new PassThrough({
      highWaterMark: 64 * 1024,
    });

    // Monitor for data flowing
    decompressProcess.stdout.once("data", () => {
      dataFlowing = true;
      console.log(`  ✓ Decompression started, streaming to S3...`);
    });

    // Track progress
    decompressProcess.stdout.on("data", (chunk: Buffer) => {
      decompressedBytes += chunk.length;
      const now = Date.now();
      if (now - lastProgressUpdate > 5000) {
        console.log(
          `  Stream progress: ${(decompressedBytes / 1e9).toFixed(2)}GB`,
        );
        lastProgressUpdate = now;
      }
    });

    // Setup error handlers before starting
    const errorHandler = (error: Error) => {
      console.error(`✗ Error:`, error.message);
      compressedStream.destroy();
      decompressProcess.kill();
      trackingStream.destroy();
      throw error;
    };

    compressedStream.on("error", errorHandler);
    decompressProcess.on("error", errorHandler);
    trackingStream.on("error", errorHandler);

    decompressProcess.stderr.on("data", (data: Buffer) => {
      const message = data.toString().trim();
      if (message && !message.includes("frame")) {
        console.log(`  zstd: ${message}`);
      }
    });

    // Setup timeout
    let timeoutCleared = false;
    const timeoutId = setTimeout(() => {
      if (!dataFlowing) {
        console.error(
          "✗ Decompression timeout: no data flowing after 60 seconds",
        );
        decompressProcess.kill();
        compressedStream.destroy();
        throw new Error("Decompression stalled");
      }
    }, 60000);

    // Pipe: compressed → zstd → tracking → S3
    compressedStream.pipe(decompressProcess.stdin);
    decompressProcess.stdout.pipe(trackingStream);

    // Upload to S3 using the stream
    console.log(`  Uploading to s3://${s3Config.bucket}/${fileName}`);
    const uploadStart = Date.now();

    // Use Upload class which handles streaming without needing ContentLength
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: s3Config.bucket,
        Key: fileName,
        Body: trackingStream,
        ContentType: "application/x-jsonl",
      },
      queueSize: 4,
      partSize: 100 * 1024 * 1024, // 100MB parts
    });

    upload.on("httpUploadProgress", (progress) => {
      if (progress.loaded) {
        const percent = progress.total
          ? ((progress.loaded / progress.total) * 100).toFixed(1)
          : "?";
        console.log(
          `  S3 upload: ${(progress.loaded / 1e9).toFixed(2)}GB (${percent}%)`,
        );
      }
    });

    await upload.done();

    clearTimeout(timeoutId);

    console.log(
      `✓ File decompressed and uploaded to S3: s3://${s3Config.bucket}/${fileName}`,
    );
    console.log(`  Streamed: ${(decompressedBytes / 1e9).toFixed(2)}GB`);
    console.log(
      `  Upload time: ${((Date.now() - uploadStart) / 1000).toFixed(2)}s`,
    );

    // Cleanup process
    decompressProcess.kill();
  } catch (error) {
    throw new Error(
      `Failed to decompress and upload to S3: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

/**
 * Stream hotel data from S3 JSONL file with batch processing
 */
async function streamHotelsFromS3(
  s3Config: S3StreamConfig,
  s3Key: string,
  onBatch: (batch: any[]) => Promise<void>,
  batchSize: number = 100,
): Promise<void> {
  const s3Client = new S3Client({
    region: s3Config.region,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
    },
  });

  console.log(`Reading hotels from S3: s3://${s3Config.bucket}/${s3Key}`);

  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: s3Key,
      }),
    );

    if (!response.Body) {
      throw new Error("No body in S3 response");
    }

    const readline = require("readline");
    const { Readable } = require("stream");

    // Convert S3 response body to readable stream
    let body = response.Body as any;

    const rl = readline.createInterface({
      input: body,
      crlfDelay: Infinity,
    });

    let batch: any[] = [];
    let lineCount = 0;
    let successCount = 0;
    let errorCount = 0;

    for await (const line of rl) {
      lineCount++;
      try {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let cleanedLine = trimmed;
        if (cleanedLine.endsWith(",")) {
          cleanedLine = cleanedLine.slice(0, -1);
        }

        if (cleanedLine.startsWith("{")) {
          const record = JSON.parse(cleanedLine);
          batch.push(record);
          successCount++;

          if (batch.length >= batchSize) {
            await onBatch([...batch]);
            batch = [];
          }
        }
      } catch (error) {
        errorCount++;
        if (errorCount <= 10) {
          console.warn(
            `⚠ Warning: Failed to parse line ${lineCount}:`,
            error instanceof Error ? error.message : error,
          );
        } else if (errorCount === 11) {
          console.warn("⚠ Suppressing further parse warnings...");
        }
      }
    }

    // Process remaining batch
    if (batch.length > 0) {
      await onBatch(batch);
    }

    console.log(`✓ Streamed ${successCount} hotel records from S3`);
    if (errorCount > 0) {
      console.warn(`⚠ Skipped ${errorCount} invalid lines`);
    }
  } catch (error) {
    throw new Error(
      `Failed to stream from S3: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

/**
 * Check if a recent decompressed file exists in S3
 * Returns the file key if found and recent (within 48 hours)
 */
async function getRecentS3File(
  s3Config: S3StreamConfig,
  maxAgeHours: number = 48,
): Promise<string | null> {
  try {
    const s3Client = new S3Client({
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    });

    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");

    const listCommand = new ListObjectsV2Command({
      Bucket: s3Config.bucket,
      Prefix: "hotel_dump_",
    });

    const response = await s3Client.send(listCommand);
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    if (!response.Contents || response.Contents.length === 0) {
      return null;
    }

    // Sort by LastModified descending and find the most recent
    const sortedFiles = response.Contents.filter(
      (obj) => obj.LastModified,
    ).sort(
      (a, b) =>
        (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0),
    );

    if (sortedFiles.length === 0) {
      return null;
    }

    const mostRecent = sortedFiles[0];
    const ageMs = now - (mostRecent.LastModified?.getTime() || 0);
    const ageHours = ageMs / (60 * 60 * 1000);

    if (ageMs < maxAgeMs) {
      console.log(
        `✓ Found recent S3 file: ${mostRecent.Key} (${ageHours.toFixed(1)} hours old)`,
      );
      return mostRecent.Key || null;
    }

    return null;
  } catch (error) {
    console.warn(
      `⚠ Could not check S3 for recent files: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return null;
  }
}

export {
  decompressStreamToS3,
  streamHotelsFromS3,
  getRecentS3File,
  S3StreamConfig,
};
