// Single shared database connection, on node:sqlite.
//
// node:sqlite ships with Node 22+, so the whole server has ZERO npm
// dependencies — `npm start` works on a clean checkout with no install step.
// Its API is synchronous, which is the right trade here: every query is a
// sub-millisecond local read, and synchronous code removes a whole class of
// interleaving bugs from the sync endpoint's read-modify-write.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

/** @type {DatabaseSync | null} */
let db = null;
let depth = 0;

export function getDb() {
  if (db) return db;

  if (config.databasePath !== ":memory:") {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }
  db = new DatabaseSync(config.databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/** Test hook: point at a fresh database without going through the env. */
export function setDatabasePath(path) {
  closeDb();
  config.databasePath = path;
}

/**
 * Runs `fn` inside an IMMEDIATE transaction. Every multi-statement write goes
 * through here — the sync endpoint in particular reads users.sync_version,
 * writes rows, then bumps it, and that has to be atomic.
 *
 * Nested calls join the outer transaction rather than opening a second one,
 * which SQLite would reject.
 */
export function transaction(fn) {
  const handle = getDb();
  if (depth > 0) {
    depth++;
    try { return fn(); } finally { depth--; }
  }

  handle.exec("BEGIN IMMEDIATE");
  depth = 1;
  try {
    const result = fn();
    handle.exec("COMMIT");
    return result;
  } catch (err) {
    try { handle.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  } finally {
    depth = 0;
  }
}

// --- Thin query helpers. Every call site reads better with these. ---
//
// node:sqlite binds an array positionally only when spread, and an object by
// name. Normalising here means callers can use whichever suits the query.
function bindArgs(params) {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

export function get(sql, params) {
  return getDb().prepare(sql).get(...bindArgs(params)) ?? null;
}

export function all(sql, params) {
  return getDb().prepare(sql).all(...bindArgs(params));
}

export function run(sql, params) {
  return getDb().prepare(sql).run(...bindArgs(params));
}

/** Prepares once and runs many times — used by the seed and the sync push. */
export function prepared(sql) {
  const stmt = getDb().prepare(sql);
  return (params) => stmt.run(...bindArgs(params));
}

export function closeDb() {
  if (db) { try { db.close(); } catch { /* already closed */ } db = null; depth = 0; }
}

export function now() { return Date.now(); }
