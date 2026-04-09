import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fsPromises } from "fs";
import axios from "axios";

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FieldSchema {
  types: Set<string>;
  nullable: boolean;
  count: number;
  example: any;
  children?: Record<string, FieldSchema>; // for object fields
  itemTypes?: Set<string>; // for array fields
  itemChildren?: Record<string, FieldSchema>; // for array-of-object fields
}

export interface SchemaReport {
  sampleSize: number;
  fields: Record<string, FieldSchema>;
  topLevelKeys: string[];
  suggestedTables: SuggestedTable[];
}

export interface SuggestedTable {
  name: string;
  columns: SuggestedColumn[];
  foreignKeys: ForeignKey[];
  indexes: string[];
}

export interface SuggestedColumn {
  name: string;
  type: string;
  nullable: boolean;
  unique?: boolean;
  primaryKey?: boolean;
}

export interface ForeignKey {
  column: string;
  references: string; // "table(column)"
  onDelete: "CASCADE" | "SET NULL" | "RESTRICT";
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema analysis helpers
// ─────────────────────────────────────────────────────────────────────────────

function detectJsType(value: any): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function mapToPgType(jsType: string, example: any): string {
  switch (jsType) {
    case "number":
      return Number.isInteger(example) ? "BIGINT" : "DECIMAL(12,6)";
    case "boolean":
      return "BOOLEAN";
    case "string": {
      const len = String(example).length;
      if (len <= 10) return "VARCHAR(20)";
      if (len <= 100) return "VARCHAR(255)";
      if (len <= 500) return "VARCHAR(1000)";
      return "TEXT";
    }
    case "object":
      return "JSONB";
    case "array":
      return "JSONB";
    default:
      return "TEXT";
  }
}

function analyzeValue(value: any): Partial<FieldSchema> {
  const type = detectJsType(value);

  if (type === "object" && value !== null) {
    const children: Record<string, FieldSchema> = {};
    for (const [k, v] of Object.entries(value)) {
      children[k] = mergeFieldSchema(undefined, analyzeValue(v) as FieldSchema);
    }
    return { types: new Set([type]), nullable: false, count: 1, example: value, children };
  }

  if (type === "array") {
    const itemTypes = new Set<string>();
    let itemChildren: Record<string, FieldSchema> | undefined;

    for (const item of value as any[]) {
      const itemType = detectJsType(item);
      itemTypes.add(itemType);

      if (itemType === "object" && item !== null) {
        if (!itemChildren) itemChildren = {};
        for (const [k, v] of Object.entries(item)) {
          itemChildren[k] = mergeFieldSchema(itemChildren[k], analyzeValue(v) as FieldSchema);
        }
      }
    }

    return { types: new Set([type]), nullable: false, count: 1, example: value, itemTypes, itemChildren };
  }

  return { types: new Set([type]), nullable: type === "null", count: 1, example: value };
}

function mergeFieldSchema(existing: FieldSchema | undefined, incoming: Partial<FieldSchema>): FieldSchema {
  if (!existing) {
    return {
      types: incoming.types ?? new Set(),
      nullable: incoming.nullable ?? false,
      count: incoming.count ?? 1,
      example: incoming.example,
      children: incoming.children,
      itemTypes: incoming.itemTypes,
      itemChildren: incoming.itemChildren,
    };
  }

  // Merge types
  for (const t of (incoming.types ?? [])) {
    existing.types.add(t);
  }

  if (incoming.nullable) existing.nullable = true;
  existing.count += incoming.count ?? 1;

  // Keep first non-null example
  if (existing.example === null && incoming.example !== null) {
    existing.example = incoming.example;
  }

  // Merge children
  if (incoming.children) {
    if (!existing.children) existing.children = {};
    for (const [k, v] of Object.entries(incoming.children)) {
      existing.children[k] = mergeFieldSchema(existing.children[k], v);
    }
  }

  // Merge item types
  if (incoming.itemTypes) {
    if (!existing.itemTypes) existing.itemTypes = new Set();
    for (const t of incoming.itemTypes) existing.itemTypes.add(t);
  }

  // Merge item children
  if (incoming.itemChildren) {
    if (!existing.itemChildren) existing.itemChildren = {};
    for (const [k, v] of Object.entries(incoming.itemChildren)) {
      existing.itemChildren[k] = mergeFieldSchema(existing.itemChildren[k], v);
    }
  }

  return existing;
}

function analyzeRecord(record: Record<string, any>, schema: Record<string, FieldSchema>, totalRecords: number): void {
  // Mark any fields present in schema but missing from this record as nullable
  for (const key of Object.keys(schema)) {
    if (!(key in record)) {
      schema[key].nullable = true;
    }
  }

  for (const [key, value] of Object.entries(record)) {
    const analyzed = analyzeValue(value) as FieldSchema;
    if (value === null || value === undefined) analyzed.nullable = true;
    schema[key] = mergeFieldSchema(schema[key], analyzed);

    // If this field is missing from some records, mark nullable
    if (schema[key].count < totalRecords) {
      schema[key].nullable = true;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Table suggestion from schema
// ─────────────────────────────────────────────────────────────────────────────

function suggestTables(schema: Record<string, FieldSchema>): SuggestedTable[] {
  const tables: SuggestedTable[] = [];

  // Main hotels table
  const hotelCols: SuggestedColumn[] = [
    { name: "id", type: "BIGSERIAL", nullable: false, primaryKey: true },
    { name: "hotel_id", type: "VARCHAR(100)", nullable: false, unique: true },
  ];

  const arrayFields: string[] = [];
  const objectFields: string[] = [];

  for (const [field, info] of Object.entries(schema)) {
    if (field === "id" || field === "hotel_id") continue;

    const types = [...info.types].filter((t) => t !== "null");
    const hasArray = types.includes("array");
    const hasObject = types.includes("object");

    if (hasArray && info.itemChildren && Object.keys(info.itemChildren).length > 3) {
      // Complex array → child table
      arrayFields.push(field);
    } else if (hasObject && info.children && Object.keys(info.children).length > 3) {
      // Complex object → JSONB or child table
      objectFields.push(field);
      hotelCols.push({
        name: field,
        type: "JSONB",
        nullable: info.nullable,
      });
    } else if (hasArray) {
      // Simple array → TEXT[] or JSONB
      const itemType = [...(info.itemTypes ?? [])].find((t) => t !== "null");
      const pgType = itemType === "string" ? "TEXT[]" : "JSONB";
      hotelCols.push({ name: field, type: pgType, nullable: info.nullable });
    } else {
      const example = info.example;
      const primaryType = types[0] ?? "string";
      let pgType = mapToPgType(primaryType, example);

      // Override common field names
      if (field.includes("_at") || field.includes("_time") || field.includes("date")) {
        pgType = "TIMESTAMPTZ";
      } else if (field === "latitude" || field === "longitude") {
        pgType = "DECIMAL(11,8)";
      } else if (field === "star_rating" || field.includes("rating")) {
        pgType = "DECIMAL(3,1)";
      } else if (field.endsWith("_id") && primaryType === "number") {
        pgType = "BIGINT";
      }

      hotelCols.push({ name: field, type: pgType, nullable: info.nullable });
    }
  }

  // Always include audit columns
  hotelCols.push(
    { name: "raw_data", type: "JSONB", nullable: true },
    { name: "created_at", type: "TIMESTAMPTZ", nullable: false },
    { name: "updated_at", type: "TIMESTAMPTZ", nullable: false },
  );

  tables.push({
    name: "hotels",
    columns: hotelCols,
    foreignKeys: [],
    indexes: ["hotel_id", "star_rating", "updated_at"],
  });

  // Child tables for complex arrays
  for (const field of arrayFields) {
    const info = schema[field];
    if (!info.itemChildren) continue;

    const childCols: SuggestedColumn[] = [
      { name: "id", type: "BIGSERIAL", nullable: false, primaryKey: true },
      { name: "hotel_id", type: "BIGINT", nullable: false },
    ];

    for (const [childField, childInfo] of Object.entries(info.itemChildren)) {
      const childTypes = [...childInfo.types].filter((t) => t !== "null");
      const primaryType = childTypes[0] ?? "string";
      let pgType = mapToPgType(primaryType, childInfo.example);
      if (primaryType === "object" || primaryType === "array") pgType = "JSONB";

      childCols.push({ name: childField, type: pgType, nullable: childInfo.nullable });
    }

    tables.push({
      name: `hotel_${field}`,
      columns: childCols,
      foreignKeys: [
        { column: "hotel_id", references: "hotels(id)", onDelete: "CASCADE" },
      ],
      indexes: ["hotel_id"],
    });
  }

  return tables;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read sample from local JSONL file
// ─────────────────────────────────────────────────────────────────────────────

async function readSampleFromFile(
  filePath: string,
  sampleSize: number,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const records: any[] = [];
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (records.length >= sampleSize) {
        rl.close();
        return;
      }
      try {
        const trimmed = line.trim();
        if (trimmed && trimmed.startsWith("{")) {
          records.push(JSON.parse(trimmed));
        }
      } catch {
        // skip malformed lines
      }
    });

    rl.on("close", () => resolve(records));
    rl.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch a sample from the WorldOTA API dump
// ─────────────────────────────────────────────────────────────────────────────

async function fetchSampleFromApi(
  keyId: string,
  apiKey: string,
  sampleSize: number,
  downloadDir: string = "./downloads",
): Promise<any[]> {
  console.log("Fetching dump URL from WorldOTA API...");

  const response = await axios.post<any>(
    "https://api.worldota.net/api/b2b/v3/hotel/info/dump/",
    { inventory: "all", language: "en" },
    {
      auth: { username: keyId, password: apiKey },
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    },
  );

  const dumpUrl: string = response.data?.data?.url;
  if (!dumpUrl) throw new Error("Could not get dump URL from API response");

  console.log(`Dump URL obtained. Downloading and decompressing for sample...`);

  // Download to a temp file
  await fsPromises.mkdir(downloadDir, { recursive: true });
  const tempCompressed = path.join(downloadDir, `schema_inspect_${Date.now()}.jsonl.zst`);
  const tempDecompressed = tempCompressed.replace(".zst", "");

  try {
    // Download
    const { default: https } = await import("https");
    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(tempCompressed);
      https.get(dumpUrl, (res) => {
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      }).on("error", reject);
    });

    console.log(`Download complete. Decompressing...`);

    // Decompress
    await execAsync(`zstd -d "${tempCompressed}" -o "${tempDecompressed}"`);
    console.log(`Decompression complete. Reading sample...`);

    // Read sample
    const records = await readSampleFromFile(tempDecompressed, sampleSize);
    console.log(`Read ${records.length} sample records.`);
    return records;
  } finally {
    // Cleanup
    for (const f of [tempCompressed, tempDecompressed]) {
      try { await fsPromises.unlink(f); } catch { /* ignore */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format schema report as human-readable text
// ─────────────────────────────────────────────────────────────────────────────

function formatFieldSchema(
  field: string,
  info: FieldSchema,
  indent: number = 0,
  recordCount: number = 1,
): string {
  const pad = " ".repeat(indent);
  const types = [...info.types].join(" | ");
  const coverage = ((info.count / recordCount) * 100).toFixed(0);
  const nullable = info.nullable ? "nullable" : "required";
  const example = JSON.stringify(info.example)?.substring(0, 80);

  let out = `${pad}${field}: ${types} [${nullable}, ${coverage}% present] → example: ${example}\n`;

  if (info.children) {
    for (const [k, v] of Object.entries(info.children)) {
      out += formatFieldSchema(k, v, indent + 2, info.count);
    }
  }

  if (info.itemChildren) {
    out += `${pad}  [array items]:\n`;
    for (const [k, v] of Object.entries(info.itemChildren)) {
      out += formatFieldSchema(k, v, indent + 4, info.count);
    }
  }

  return out;
}

function generateSqlDDL(tables: SuggestedTable[]): string {
  let sql = "";

  for (const table of tables) {
    sql += `-- ────────────────────────────────────────────\n`;
    sql += `CREATE TABLE IF NOT EXISTS ${table.name} (\n`;

    const colLines = table.columns.map((col) => {
      let line = `  ${col.name} ${col.type}`;
      if (col.primaryKey) line += " PRIMARY KEY";
      if (!col.nullable && !col.primaryKey) line += " NOT NULL";
      if (col.unique) line += " UNIQUE";
      if (col.name === "created_at" || col.name === "updated_at") {
        line += " DEFAULT NOW()";
      }
      return line;
    });

    for (const fk of table.foreignKeys) {
      colLines.push(
        `  CONSTRAINT fk_${table.name}_${fk.column} FOREIGN KEY (${fk.column}) REFERENCES ${fk.references} ON DELETE ${fk.onDelete}`,
      );
    }

    sql += colLines.join(",\n");
    sql += "\n);\n\n";

    for (const idx of table.indexes) {
      sql += `CREATE INDEX IF NOT EXISTS idx_${table.name}_${idx} ON ${table.name}(${idx});\n`;
    }

    sql += "\n";
  }

  return sql;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main inspector function
// ─────────────────────────────────────────────────────────────────────────────

export async function inspectHotelSchema(options: {
  localFilePath?: string;
  keyId?: string;
  apiKey?: string;
  sampleSize?: number;
  downloadDir?: string;
  outputSql?: boolean;
}): Promise<SchemaReport> {
  const { sampleSize = 100, outputSql = true } = options;

  let records: any[];

  if (options.localFilePath) {
    console.log(`Reading from local file: ${options.localFilePath}`);
    records = await readSampleFromFile(options.localFilePath, sampleSize);
  } else if (options.keyId && options.apiKey) {
    records = await fetchSampleFromApi(
      options.keyId,
      options.apiKey,
      sampleSize,
      options.downloadDir,
    );
  } else {
    throw new Error("Provide either localFilePath or keyId+apiKey");
  }

  if (records.length === 0) {
    throw new Error("No records found to analyze");
  }

  console.log(`\nAnalyzing schema from ${records.length} records...`);

  const schema: Record<string, FieldSchema> = {};
  let totalRecords = 0;

  for (const record of records) {
    totalRecords++;
    analyzeRecord(record, schema, totalRecords);
  }

  const topLevelKeys = Object.keys(schema).sort();
  const suggestedTables = suggestTables(schema);

  const report: SchemaReport = {
    sampleSize: records.length,
    fields: schema,
    topLevelKeys,
    suggestedTables,
  };

  // Print report
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║           Hotel Schema Analysis Report        ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log(`Sample size: ${records.length} records\n`);
  console.log("Top-level fields:");
  console.log("─".repeat(60));

  for (const field of topLevelKeys) {
    process.stdout.write(formatFieldSchema(field, schema[field], 0, totalRecords));
  }

  if (outputSql) {
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║         Suggested SQL DDL (from analysis)     ║");
    console.log("╚══════════════════════════════════════════════╝\n");
    console.log(generateSqlDDL(suggestedTables));
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const localFile = process.argv[2]; // Optional: path to local .jsonl file

  inspectHotelSchema({
    localFilePath: localFile ?? undefined,
    keyId: localFile ? undefined : process.env.KEY_ID,
    apiKey: localFile ? undefined : process.env.API_KEY,
    sampleSize: parseInt(process.env.SAMPLE_SIZE ?? "200", 10),
    downloadDir: process.env.DOWNLOAD_DIR ?? "./downloads",
    outputSql: true,
  }).catch((err) => {
    console.error("Schema inspection failed:", err.message);
    process.exit(1);
  });
}
