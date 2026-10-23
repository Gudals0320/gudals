// SQLite connection setup. Uses the built-in node:sqlite (no native addon to
// build on Windows). Several processes may write the same file: WAL lets readers
// run alongside a writer, and busy_timeout makes writers wait instead of failing.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSchema } from "./schema.ts";

export const PROJECT_ROOT = path.join(import.meta.dirname, "..", "..");
/**
 * Where runs, archives and the rate-limit database live: INQUIRY_DATA_DIR if set,
 * else "dataDir" from inquiry.config.json beside the code (a bundled copy, such as
 * the plugin, uses "~/.inquiry"), else data/ in this repository.
 */
export function dataDirFor(root: string, env: Record<string, string | undefined> = process.env): string {
  if (env.INQUIRY_DATA_DIR) return env.INQUIRY_DATA_DIR;
  const cfg = path.join(root, "inquiry.config.json");
  if (existsSync(cfg)) {
    const dir = String(JSON.parse(readFileSync(cfg, "utf8")).dataDir ?? "");
    if (dir) return dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : path.resolve(root, dir);
  }
  return path.join(root, "data");
}
export const DATA_DIR = dataDirFor(PROJECT_ROOT);
export const DEFAULT_DB_PATH = path.join(DATA_DIR, "inquiry.db");
export const DEFAULT_ARCHIVE_DIR = path.join(DATA_DIR, "archive");

export const BUSY_TIMEOUT_MS = 10_000;

export function openDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  createSchema(db);
  return db;
}
