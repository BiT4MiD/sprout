// Applies schema.sql. Safe to run repeatedly — every statement is
// CREATE TABLE IF NOT EXISTS.
//
// Future migrations: add numbered files under src/db/migrations/ and compare
// against schema_meta.version rather than editing schema.sql in place, so an
// existing database can be upgraded instead of recreated.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, get } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(HERE, "schema.sql");

export function readSchema() {
  return readFileSync(SCHEMA_PATH, "utf8");
}

export function migrate() {
  getDb().exec(readSchema());
  return schemaVersion();
}

export function schemaVersion() {
  const row = get("SELECT value FROM schema_meta WHERE key = 'version'");
  return row ? Number(row.value) : 0;
}

/** Called at boot: applies the schema if the database is empty. */
export function ensureSchema() {
  const table = get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'"
  );
  if (!table) return migrate();
  return schemaVersion();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`Schema applied (version ${migrate()}).`);
}
