import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.join(process.cwd(), "public", "policies.db");
const OUT_PATH = path.join(process.cwd(), "public", "policies-embeddings.json");

// --- Google Embeddings (v1, text-embedding-004) ---
const API_KEY = process.env.GOOGLE_API_KEY || "";
const EMB_URL = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${encodeURIComponent(
  API_KEY
)}`;

if (!API_KEY) {
  console.error("Missing GOOGLE_API_KEY");
  process.exit(1);
}

// Load pages from SQLite
const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .prepare(
    `
  SELECT rowid AS id, fileName, relativePath, page, text
  FROM pages_fts
  ORDER BY rowid ASC
`
  )
  .all();

console.log(`Embedding ${rows.length} pages...`);

async function embed(text) {
  // Keep payload reasonable for embeddings
  const snippet = String(text).replace(/\s+/g, " ").slice(0, 4000);
  const body = {
    content: { parts: [{ text: snippet }] },
    taskType: "RETRIEVAL_DOCUMENT",
  };
  const r = await fetch(EMB_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`embed HTTP ${r.status}: ${t}`);
  }
  const j = await r.json();
  const vec = j.embedding?.values;
  if (!Array.isArray(vec)) throw new Error("No embedding.values");
  return vec;
}

const out = {
  model: "text-embedding-004",
  dim: 768,
  items: [],
};

const BATCH = 8;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const vecs = await Promise.all(
    chunk.map(async (r) => ({
      id: r.id,
      fileName: r.fileName,
      relativePath: r.relativePath,
      page: r.page,
      vector: await embed(r.text),
    }))
  );
  out.items.push(...vecs);
  process.stdout.write(
    `\r${Math.min(i + BATCH, rows.length)} / ${rows.length}`
  );
}
process.stdout.write("\n");

fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log("Wrote", OUT_PATH);
