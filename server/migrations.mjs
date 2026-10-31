// Schama bootstrap / migration runner. The schema file is re-executed on every
// start (all statements are idempotent); future structural migrations are
// appended as ordered, transactional steps keyed by app_meta.schema_version.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { iso } from "./core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(root, "server/schema.sql");
const SCHEMA_VERSION = 1;

export function migrateDatabase(db, { schemaSql } = {}) {
  const sql = schemaSql ?? fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql);
  const row = db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get();
  const current = Number(row?.value || 0);
  if (current < SCHEMA_VERSION) {
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO app_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(SCHEMA_VERSION));
      db.prepare(
        "INSERT INTO app_meta(key,value) VALUES('schema_updated_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(iso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { version: SCHEMA_VERSION, sql };
}

export function schemaVersion(db) {
  return Number(db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()?.value || 0);
}
