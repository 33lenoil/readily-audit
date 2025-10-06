import path from "node:path";
import DatabaseCtor from "better-sqlite3";

// Derive the instance type from the constructor
type DB = InstanceType<typeof DatabaseCtor>;

let db: DB | null = null;

export function getDb(): DB {
  if (!db) {
    const dbPath = path.resolve(process.cwd(), "public", "policies.db");
    db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
    // Optional for reads; safe to keep
    db.pragma("journal_mode = WAL");
  }
  return db;
}
