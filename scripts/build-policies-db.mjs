import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
// ➜ Use the Node/legacy ESM build. No worker needed in Node.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const SRC_DIR = path.resolve("policies-src");
const OUT_DB = path.resolve("public/policies.db");

// Walk all files recursively
function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function extractPagesFromPdf(absPath) {
  const data = new Uint8Array(fs.readFileSync(absPath));
  // IMPORTANT: disable worker in Node
  const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => (typeof it.str === "string" ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(text);
  }
  await doc.destroy();
  return pages;
}

async function main() {
  console.log("Building SQLite index →", OUT_DB);
  fs.mkdirSync(path.dirname(OUT_DB), { recursive: true });
  if (fs.existsSync(OUT_DB)) fs.unlinkSync(OUT_DB);

  const db = new Database(OUT_DB);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE pages (
      id           INTEGER PRIMARY KEY,
      fileName     TEXT NOT NULL,
      relativePath TEXT NOT NULL,
      page         INTEGER NOT NULL,
      text         TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      text, fileName, relativePath, page,
      tokenize = 'unicode61'
    );
  `);

  const insertPage = db.prepare(`
    INSERT INTO pages (fileName, relativePath, page, text)
    VALUES (?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO pages_fts (rowid, text, fileName, relativePath, page)
    VALUES (?, ?, ?, ?, ?)
  `);

  const files = [...walk(SRC_DIR)].filter((p) =>
    p.toLowerCase().endsWith(".pdf")
  );
  if (!files.length) {
    console.error(`No PDFs found under ${SRC_DIR}. Add files and rerun.`);
    process.exit(1);
  }

  let totalPages = 0;

  for (const absPath of files) {
    const fileName = path.basename(absPath);
    const relativePath = path.relative(SRC_DIR, absPath).replaceAll("\\", "/");
    console.log("Parsing:", relativePath);

    const pages = await extractPagesFromPdf(absPath);

    db.transaction(() => {
      pages.forEach((text, idx) => {
        if (!text) return;
        const info = insertPage.run(fileName, relativePath, idx + 1, text);
        insertFts.run(
          info.lastInsertRowid,
          text,
          fileName,
          relativePath,
          idx + 1
        );
        totalPages++;
      });
    })();
  }

  db.exec(`ANALYZE;`);
  db.close();
  console.log(
    `Done. Indexed ${files.length} PDFs, ${totalPages} pages -> ${OUT_DB}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
