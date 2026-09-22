// Applies db/migrations/*.sql in filename order, once each, tracked in schema_migrations.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

// PRAGMAs inside a transaction are silently ignored (journal_mode) or forbidden; openStore sets them itself.
const stripPragmas = (sql: string): string =>
  sql
    .split("\n")
    .filter((line) => !/^\s*PRAGMA\s/i.test(line))
    .join("\n");

export function listMigrations(dir: string = MIGRATIONS_DIR): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, "utf8") }));
}

/** Returns the names of migrations applied by this call. */
export function applyMigrations(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r) => String(r.name)),
  );
  const applied: string[] = [];
  const mark = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  for (const m of listMigrations(dir)) {
    if (done.has(m.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(stripPragmas(m.sql));
      mark.run(m.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    applied.push(m.name);
  }
  return applied;
}
