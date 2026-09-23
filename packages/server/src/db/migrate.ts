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

export function applyMigrations(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r) => String(r.name)),
  );
  const mark = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(stripPragmas(readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8")));
      mark.run(name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
