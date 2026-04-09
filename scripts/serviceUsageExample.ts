import HotelDumpService from "../src/services/hotelDumpService";

// Example 1: Basic usage with all records in memory
async function basicExample() {
  const service = new HotelDumpService({
    keyId: process.env.KEY_ID!,
    apiKey: process.env.API_KEY!,
    inventory: "all",
    language: "en",
  });

  try {
    const { records, stats } = await service.processHotelDump();

    console.log(`Processed ${records.length} hotels`);
    console.log("First hotel:", records[0]);
  } catch (error) {
    console.error("Failed:", error);
  }
}

// Example 2: Streaming with batch processing (memory efficient)
async function streamingExample() {
  const service = new HotelDumpService({
    keyId: process.env.KEY_ID!,
    apiKey: process.env.API_KEY!,
    batchSize: 500, // Process in batches of 500
  });

  let totalProcessed = 0;

  try {
    await service.processHotelDump({
      onBatch: async (batch) => {
        // Process each batch (e.g., insert into database)
        console.log(`Processing batch of ${batch.length} hotels...`);

        // Example: Filter and process
        const luxuryHotels = batch.filter((hotel) => hotel.star_rating >= 4);

        // Example: Save to database
        // await db.hotels.insertMany(batch);

        totalProcessed += batch.length;
      },
    });

    console.log(`Total processed: ${totalProcessed}`);
  } catch (error) {
    console.error("Failed:", error);
  }
}

// Example 3: With S3 upload and file retention
async function s3Example() {
  const service = new HotelDumpService({
    keyId: process.env.API_KEY_ID!,
    apiKey: process.env.API_KEY!,
    s3Config: {
      region: process.env.AWS_REGION || "us-east-1",
      bucket: process.env.S3_BUCKET!,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      serverSideEncryption: "AES256",
    },
  });

  try {
    const { records, stats } = await service.processHotelDump({
      uploadToS3: true,
      keepFiles: true, // Keep decompressed file locally
    });

    console.log("Stats:", stats);
  } catch (error) {
    console.error("Failed:", error);
  }
}

// Example 4: Custom configuration with retries
async function customConfigExample() {
  const service = new HotelDumpService({
    keyId: process.env.KEY_ID!,
    apiKey: process.env.API_KEY!,
    downloadDir: "./data/dumps",
    maxRetries: 5,
    retryDelayMs: 2000,
    batchSize: 1000,
    inventory: "direct",
    language: "es",
  });

  try {
    const { records, stats } = await service.processHotelDump();
    console.log(`Processing took ${stats.processingTimeMs}ms`);
  } catch (error) {
    console.error("Failed:", error);
  }
}

// Example 5: Only download and decompress (no parsing)
async function downloadOnlyExample() {
  const service = new HotelDumpService({
    keyId: process.env.API_KEY_ID!,
    apiKey: process.env.API_KEY!,
  });

  try {
    // Fetch URL
    const dumpResponse = await service.fetchDumpUrl();

    // Download
    const compressedPath = await service.downloadDump(dumpResponse.data.url);

    // Decompress
    const decompressedPath = await service.decompressDump(compressedPath);

    console.log(`Decompressed file available at: ${decompressedPath}`);
  } catch (error) {
    console.error("Failed:", error);
  }
}

// Run example
if (require.main === module) {
  // Change this to run different examples
  streamingExample().catch(console.error);
}

export {
  basicExample,
  streamingExample,
  s3Example,
  customConfigExample,
  downloadOnlyExample,
};
