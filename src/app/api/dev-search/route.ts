import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";

interface DbRow {
  fileName: string;
  relativePath: string;
  page: number;
  text: string;
}

export const runtime = "node"; // ensure Node runtime for better-sqlite3

function buildFtsQuery(q: string) {
  // Minimal keywordizer: keep words & numbers, quote phrases like "calendar days"
  const raw = q
    .toLowerCase()
    .replace(/[^a-z0-9\s\-()"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Try to detect exact phrases (e.g., "calendar days") the user typed with quotes already
  // Otherwise AND all tokens
  const tokens = raw.split(" ").filter(Boolean);
  if (!tokens.length) return "";

  // Very small boost: if any number present, OR the number and the worded version (e.g., 14|fourteen)
  // Keep it simple for now: just AND tokens
  const andQuery = tokens.map((t) => (t.includes('"') ? t : t)).join(" AND ");
  return andQuery;
}

export async function POST(req: NextRequest) {
  try {
    const { q, limit = 3 } = await req.json();
    if (!q || typeof q !== "string") {
      return new Response(JSON.stringify({ error: "Provide { q: string }" }), {
        status: 400,
      });
    }

    const db = getDb();
    const ftsQuery = buildFtsQuery(q);
    if (!ftsQuery) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }

    const stmt = db.prepare(`
      SELECT fileName, relativePath, page, text
      FROM pages_fts
      WHERE pages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    const rows = (stmt.all(ftsQuery, Number(limit) || 3) as DbRow[]).map(
      (r) => ({
        fileName: r.fileName,
        relativePath: r.relativePath,
        page: r.page,
        // send a short preview to keep payload small
        preview: String(r.text).slice(0, 500),
      })
    );

    return new Response(JSON.stringify({ query: q, ftsQuery, results: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e: unknown) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      {
        status: 500,
      }
    );
  }
}
