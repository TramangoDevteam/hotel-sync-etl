#!/usr/bin/env node

const { Pool } = require("pg");
const fs = require("fs");

const config = {
  host: process.env.DB_HOST || "pg-36fa4308-ohiozeomiunu-bc63.l.aivencloud.com",
  port: process.env.DB_PORT || 25805,
  database: process.env.DB_NAME || "defaultdb",
  user: process.env.DB_USER || "avnadmin",
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
  },
};

const pool = new Pool(config);
let lastCount = 0;
let lastTimestamp = Date.now();

function formatNumber(num) {
  return num.toLocaleString();
}

function clearScreen() {
  console.clear();
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║        PostgreSQL Hotels Table - Real-Time Monitor        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
}

async function updateStats() {
  try {
    const client = await pool.connect();

    // Get total count
    const countResult = await client.query(
      "SELECT COUNT(*) as total FROM hotels",
    );
    const totalCount = parseInt(countResult.rows[0].total);

    // Get records by country
    const countryResult = await client.query(
      "SELECT country, COUNT(*) as count FROM hotels GROUP BY country ORDER BY count DESC LIMIT 10",
    );

    // Get records by city
    const cityResult = await client.query(
      "SELECT city, country, COUNT(*) as count FROM hotels WHERE city IS NOT NULL GROUP BY city, country ORDER BY count DESC LIMIT 10",
    );

    // Get star rating distribution
    const starsResult = await client.query(
      `SELECT 
        COALESCE(star_rating::text, 'N/A') as rating, 
        COUNT(*) as count 
       FROM hotels 
       GROUP BY star_rating 
       ORDER BY star_rating DESC NULLS LAST`,
    );

    // Get recent inserts
    const recentResult = await client.query(
      "SELECT hotel_id, name, city, country, updated_at FROM hotels ORDER BY updated_at DESC LIMIT 5",
    );

    // Calculate insert rate
    const timeDiff = (Date.now() - lastTimestamp) / 1000; // seconds
    const countDiff = totalCount - lastCount;
    const insertRate = timeDiff > 0 ? (countDiff / timeDiff).toFixed(2) : 0;

    lastCount = totalCount;
    lastTimestamp = Date.now();

    clearScreen();

    // Summary
    console.log("📊 SUMMARY");
    console.log("─".repeat(60));
    console.log(`  Total Hotels: ${formatNumber(totalCount)}`);
    console.log(`  Insert Rate: ${insertRate} records/sec`);
    console.log(`  Last Updated: ${new Date().toLocaleTimeString()}`);
    console.log("");

    // Top Countries
    console.log("🌍 TOP COUNTRIES");
    console.log("─".repeat(60));
    countryResult.rows.forEach((row, i) => {
      const bar = "█".repeat(Math.ceil(row.count / 500));
      console.log(
        `  ${(i + 1).toString().padStart(2)}. ${row.country?.padEnd(25) || "Unknown".padEnd(25)} ${formatNumber(row.count).padStart(8)} ${bar}`,
      );
    });
    console.log("");

    // Top Cities
    console.log("🏙️  TOP CITIES");
    console.log("─".repeat(60));
    cityResult.rows.slice(0, 5).forEach((row, i) => {
      console.log(
        `  ${(i + 1).toString().padStart(2)}. ${(row.city || "Unknown").padEnd(20)} (${row.country}) - ${formatNumber(row.count)}`,
      );
    });
    console.log("");

    // Star Ratings
    console.log("⭐ STAR RATING DISTRIBUTION");
    console.log("─".repeat(60));
    starsResult.rows.forEach((row) => {
      const bar = "█".repeat(Math.ceil(row.count / 500));
      console.log(
        `  ${row.rating?.toString().padEnd(5)} ${formatNumber(row.count).padStart(8)} ${bar}`,
      );
    });
    console.log("");

    // Recent Inserts
    console.log("⏱️  RECENT INSERTS");
    console.log("─".repeat(60));
    recentResult.rows.forEach((row, i) => {
      const time = new Date(row.updated_at).toLocaleTimeString();
      console.log(
        `  ${time} | ${row.name?.substring(0, 30).padEnd(30)} (${row.city}, ${row.country})`,
      );
    });

    console.log("\n💡 Press Ctrl+C to exit\n");

    client.release();
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

// Run every 2 seconds
console.log("Connecting to PostgreSQL...");
updateStats();
setInterval(updateStats, 2000);

// Graceful exit
process.on("SIGINT", async () => {
  console.log("\n✓ Closing connection...");
  await pool.end();
  process.exit(0);
});
