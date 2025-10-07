import path from "node:path";
import fs from "node:fs";

type PageRow = {
  fileName: string;
  relativePath: string;
  page: number;
  text: string;
};

type PagesIndex = Record<string, string>; // "fileName#page" -> "text"

let pagesCache: PagesIndex | null = null;

function getPagesIndex(): PagesIndex {
  if (!pagesCache) {
    const indexPath = path.resolve(process.cwd(), "public", "pages-index.json");

    if (!fs.existsSync(indexPath)) {
      throw new Error(
        `Pages index not found at ${indexPath}. Run 'node scripts/dump-pages-json-sqljs.mjs' to generate it.`
      );
    }

    const raw = fs.readFileSync(indexPath, "utf8");
    pagesCache = JSON.parse(raw) as PagesIndex;
  }
  return pagesCache;
}

export type PageFetcher = {
  get: (fileName: string, page: number) => PageRow | undefined;
};

export function getDb(): PageFetcher {
  const index = getPagesIndex();

  return {
    get: (fileName: string, page: number): PageRow | undefined => {
      const key = `${fileName}#${page}`;
      const text = index[key];

      if (!text) {
        return undefined;
      }

      return {
        fileName,
        relativePath: "", // Not stored in JSON, but not used in check route
        page,
        text,
      };
    },
  };
}
