import fs from "node:fs";
import path from "node:path";

export type EmbItem = {
  id: number;
  fileName: string;
  relativePath: string;
  page: number;
  vector: number[];
};

export type EmbIndex = {
  model: string;
  dim: number;
  items: EmbItem[];
};

let cache: EmbIndex | null = null;

export function getEmbIndex(): EmbIndex {
  if (cache) return cache;
  const p = path.join(process.cwd(), "public", "policies-embeddings.json");
  const raw = fs.readFileSync(p, "utf8");
  cache = JSON.parse(raw) as EmbIndex;
  return cache!;
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}
