import { Pool, PoolClient } from "pg";
import { HotelRecord } from "./hotelDumpService";

export interface PostgresConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  ssl?:
    | boolean
    | {
        rejectUnauthorized?: boolean;
        ca?: string;
        key?: string;
        cert?: string;
      };
}

export interface InsertStats {
  totalRecords: number;
  successfulInserts: number;
  failedInserts: number;
  insertTimeMs: number;
}

class PostgresService {
  private pool: Pool;
  private config: Required<Omit<PostgresConfig, "ssl">> & {
    ssl?: PostgresConfig["ssl"];
  };

  constructor(config: PostgresConfig) {
    if (!config.host || !config.database || !config.user || !config.password) {
      throw new Error(
        "PostgreSQL config requires host, database, user, and password",
      );
    }

    this.config = {
      port: 5432,
      maxConnections: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      ...config,
    } as any;

    const poolConfig: any = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      max: this.config.maxConnections,
      idleTimeoutMillis: this.config.idleTimeoutMillis,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis,
    };

    // Handle SSL configuration
    if (this.config.ssl) {
      if (typeof this.config.ssl === "boolean") {
        // Simple SSL mode
        poolConfig.ssl = {
          rejectUnauthorized: false, // For Aiven and self-signed certs
        };
      } else {
        // SSL config object
        poolConfig.ssl = this.config.ssl;
      }
    }

    this.pool = new Pool(poolConfig);

    this.pool.on("error", (error) => {
      console.error("Unexpected error in PostgreSQL pool:", error);
    });
  }

  /**
   * Verify database connection
   */
  async testConnection(): Promise<void> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      const result = await client.query("SELECT NOW()");
      console.log(`✓ PostgreSQL connection successful: ${result.rows[0].now}`);
    } catch (error) {
      throw new Error(
        `Failed to connect to PostgreSQL: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Create hotels table if it doesn't exist
   */
  async createHotelsTable(): Promise<void> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS hotels (
          id SERIAL PRIMARY KEY,
          hotel_id VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(500),
          description TEXT,
          country VARCHAR(255),
          state VARCHAR(255),
          city VARCHAR(255),
          zip_code VARCHAR(100),
          address VARCHAR(500),
          latitude DECIMAL(10, 8),
          longitude DECIMAL(11, 8),
          star_rating DECIMAL(2, 1),
          phone VARCHAR(100),
          fax VARCHAR(100),
          website VARCHAR(500),
          email VARCHAR(255),
          check_in_time VARCHAR(50),
          check_out_time VARCHAR(50),
          images TEXT[],
          amenities TEXT[],
          languages TEXT[],
          raw_data JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_hotels_hotel_id ON hotels(hotel_id);
        CREATE INDEX IF NOT EXISTS idx_hotels_city ON hotels(city);
        CREATE INDEX IF NOT EXISTS idx_hotels_country ON hotels(country);
        CREATE INDEX IF NOT EXISTS idx_hotels_star_rating ON hotels(star_rating);
        CREATE INDEX IF NOT EXISTS idx_hotels_updated_at ON hotels(updated_at);
      `;

      await client.query(createTableQuery);
      console.log("✓ Hotels table ready");
    } catch (error) {
      throw new Error(
        `Failed to create hotels table: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Insert hotel records into database with upsert logic
   */
  async insertHotels(
    records: HotelRecord[],
    options: {
      upsert?: boolean; // Update if exists, insert if not
      batchSize?: number;
    } = {},
  ): Promise<InsertStats> {
    const startTime = Date.now();
    const { upsert = true, batchSize = 100 } = options;

    let client: PoolClient | null = null;
    let successfulInserts = 0;
    let failedInserts = 0;

    try {
      client = await this.pool.connect();

      // Process in batches to avoid connection timeouts
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);

        // Build multi-row insert query
        const values: any[] = [];
        const placeholders: string[] = [];
        let paramIndex = 1;

        for (const record of batch) {
          const hotelId = record.id || record.hotel_id || `hotel_${Date.now()}`;
          const images = Array.isArray(record.images) ? record.images : [];
          const amenities = Array.isArray(record.amenities)
            ? record.amenities
            : [];
          const languages = Array.isArray(record.languages)
            ? record.languages
            : [];

          values.push(
            hotelId,
            record.name || null,
            record.description || null,
            record.country || null,
            record.state || null,
            record.city || null,
            record.zip_code || null,
            record.address || null,
            record.latitude || null,
            record.longitude || null,
            record.star_rating || null,
            record.phone || null,
            record.fax || null,
            record.website || null,
            record.email || null,
            record.check_in_time || null,
            record.check_out_time || null,
            images,
            amenities,
            languages,
            JSON.stringify(record),
          );

          placeholders.push(
            `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${
              paramIndex + 3
            }, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${
              paramIndex + 7
            }, $${paramIndex + 8}, $${paramIndex + 9}, $${paramIndex + 10}, $${
              paramIndex + 11
            }, $${paramIndex + 12}, $${paramIndex + 13}, $${paramIndex + 14}, $${
              paramIndex + 15
            }, $${paramIndex + 16}, $${paramIndex + 17}, $${paramIndex + 18}, $${
              paramIndex + 19
            }, $${paramIndex + 20})`,
          );
          paramIndex += 21;
        }

        const baseQuery = `
          INSERT INTO hotels (
            hotel_id, name, description, country, state, city, zip_code, address,
            latitude, longitude, star_rating, phone, fax, website, email,
            check_in_time, check_out_time, images, amenities, languages, raw_data
          ) VALUES ${placeholders.join(", ")}
        `;

        const query = upsert
          ? baseQuery +
            `
          ON CONFLICT (hotel_id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            country = EXCLUDED.country,
            state = EXCLUDED.state,
            city = EXCLUDED.city,
            zip_code = EXCLUDED.zip_code,
            address = EXCLUDED.address,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            star_rating = EXCLUDED.star_rating,
            phone = EXCLUDED.phone,
            fax = EXCLUDED.fax,
            website = EXCLUDED.website,
            email = EXCLUDED.email,
            check_in_time = EXCLUDED.check_in_time,
            check_out_time = EXCLUDED.check_out_time,
            images = EXCLUDED.images,
            amenities = EXCLUDED.amenities,
            languages = EXCLUDED.languages,
            raw_data = EXCLUDED.raw_data,
            updated_at = CURRENT_TIMESTAMP
          RETURNING hotel_id
        `
          : baseQuery + ` RETURNING hotel_id`;

        try {
          const result = await client.query(query, values);
          successfulInserts += result.rowCount || 0;
        } catch (error) {
          console.error(
            `✗ Error inserting batch (records ${i + 1}-${i + batch.length}):`,
            error instanceof Error ? error.message : error,
          );
          failedInserts += batch.length;
        }

        // Progress logging
        if ((i + batchSize) % 500 === 0) {
          console.log(`  Inserted: ${successfulInserts} records`);
        }
      }

      console.log(
        `✓ Database insert complete: ${successfulInserts} records processed`,
      );
      if (failedInserts > 0) {
        console.warn(`⚠ ${failedInserts} records failed to insert`);
      }

      return {
        totalRecords: records.length,
        successfulInserts,
        failedInserts,
        insertTimeMs: Date.now() - startTime,
      };
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Insert hotels from batch callback (streaming style)
   */
  async insertHotelsBatch(
    onBatch: (
      insertFn: (batch: HotelRecord[]) => Promise<void>,
    ) => Promise<void>,
  ): Promise<InsertStats> {
    const startTime = Date.now();
    let successfulInserts = 0;
    let totalRecords = 0;
    let failedInserts = 0;

    try {
      await onBatch(async (batch: HotelRecord[]) => {
        totalRecords += batch.length;
        const stats = await this.insertHotels(batch, {
          upsert: true,
          batchSize: 100,
        });
        successfulInserts += stats.successfulInserts;
        failedInserts += stats.failedInserts;
      });

      return {
        totalRecords,
        successfulInserts,
        failedInserts,
        insertTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(
        `Failed to insert hotels batch: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  /**
   * Get hotel count in database
   */
  async getHotelCount(): Promise<number> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      const result = await client.query("SELECT COUNT(*) as count FROM hotels");
      return parseInt(result.rows[0].count, 10);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Get hotel by ID
   */
  async getHotel(hotelId: string): Promise<HotelRecord | null> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      const result = await client.query(
        "SELECT raw_data FROM hotels WHERE hotel_id = $1",
        [hotelId],
      );
      return result.rows.length > 0
        ? (JSON.parse(result.rows[0].raw_data) as HotelRecord)
        : null;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Search hotels by city and optional star rating
   */
  async searchHotels(
    city: string,
    minStarRating?: number,
  ): Promise<HotelRecord[]> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      let query = "SELECT raw_data FROM hotels WHERE city ILIKE $1";
      const params: any[] = [`%${city}%`];

      if (minStarRating !== undefined) {
        query += ` AND star_rating >= $2`;
        params.push(minStarRating);
      }

      const result = await client.query(query, params);
      return result.rows.map((row) => JSON.parse(row.raw_data) as HotelRecord);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Close database connection pool
   */
  async close(): Promise<void> {
    try {
      await this.pool.end();
      console.log("✓ PostgreSQL connection pool closed");
    } catch (error) {
      console.error("Error closing connection pool:", error);
    }
  }
}

export default PostgresService;
export { PostgresService };
