import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";

console.log("Starting pages dump with sql.js...");

const DB_PATH = path.join(process.cwd(), "public", "policies.db");
const OUT_PATH = path.join(process.cwd(), "public", "pages-index.json");

console.log("DB Path:", DB_PATH);
console.log("Output Path:", OUT_PATH);

try {
  console.log("Initializing SQL.js...");
  const SQL = await initSqlJs();

  console.log("Reading database file...");
  const buffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  console.log("Querying pages...");
  const result = db.exec(`
    SELECT fileName, page, text
    FROM pages
    ORDER BY fileName ASC, page ASC
  `);

  if (!result || result.length === 0) {
    console.error("No results found");
    process.exit(1);
  }

  const rows = result[0].values;
  console.log(`Found ${rows.length} pages`);

  // build a compact map: {"GG.1503_CEO...pdf#3":"...text..."}
  const map = Object.create(null);
  for (const row of rows) {
    const [fileName, page, text] = row;
    const key = `${fileName}#${page}`;
    // keep it raw; we'll trim at runtime
    map[key] = String(text);
  }

  console.log("Writing to file...");
  fs.writeFileSync(OUT_PATH, JSON.stringify(map));

  const stats = fs.statSync(OUT_PATH);
  console.log(`✅ Wrote ${OUT_PATH}`);
  console.log(`   ${rows.length} pages`);
  console.log(`   ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  db.close();
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
