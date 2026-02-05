// Export all services
export { default as HotelDumpService } from "./services/hotelDumpService";
export {
  HotelDumpService as HS,
  type DumpServiceConfig,
  type ProcessingStats,
} from "./services/hotelDumpService";

export { default as PostgresService } from "./services/postgresService";
export {
  PostgresService as PS,
  type PostgresConfig,
  type InsertStats,
} from "./services/postgresService";

export {
  decompressStreamToS3,
  streamHotelsFromS3,
  type S3StreamConfig,
} from "./services/s3StreamService";

// Export pipeline
export { default as HotelSyncPipeline } from "./pipelines/hotelSyncPipeline";
export {
  HotelSyncPipeline as Pipeline,
  type PipelineConfig,
  type PipelineStats,
} from "./pipelines/hotelSyncPipeline";

// Re-export common types
export type { HotelRecord } from "./services/hotelDumpService";
