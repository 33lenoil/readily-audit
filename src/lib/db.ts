// Import the pages index directly - this works in both local and Vercel
import pagesIndexData from "../../public/pages-index.json";

type PageRow = {
  fileName: string;
  relativePath: string;
  page: number;
  text: string;
};

type PagesIndex = Record<string, string>; // "fileName#page" -> "text"

// Cast the imported data to the correct type
const pagesIndex = pagesIndexData as PagesIndex;

console.log(`✅ Loaded ${Object.keys(pagesIndex).length} pages from index`);

export type PageFetcher = {
  get: (fileName: string, page: number) => PageRow | undefined;
};

export function getDb(): PageFetcher {
  return {
    get: (fileName: string, page: number): PageRow | undefined => {
      const key = `${fileName}#${page}`;
      const text = pagesIndex[key];

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
