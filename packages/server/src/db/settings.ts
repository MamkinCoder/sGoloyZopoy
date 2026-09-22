import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "@sgz/shared";
import { str, type Sql } from "./sql.js";

type SettingsRepo = Pick<Store, "getSetting" | "setSetting" | "insertLLMCall" | "backup">;

export function settingsRepo(s: Sql): SettingsRepo {
  return {
    getSetting(key) {
      const r = s.get("SELECT value FROM settings WHERE key = ?", key);
      return r ? str(r.value) : null;
    },
    setSetting(key, value) {
      s.run("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
    },
    insertLLMCall(c) {
      s.run(
        `INSERT INTO llm_calls (run_id, task, model, prompt_chars, result_chars, duration_ms, ok, error, attempt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        c.runId,
        c.task,
        c.model,
        c.promptChars,
        c.resultChars,
        c.durationMs,
        c.ok,
        c.error,
        c.attempt,
      );
    },
    backup(destPath) {
      mkdirSync(dirname(destPath), { recursive: true });
      // VACUUM INTO writes a compact consistent copy and refuses to overwrite an existing file.
      s.db.prepare("VACUUM INTO ?").run(destPath);
    },
  };
}
