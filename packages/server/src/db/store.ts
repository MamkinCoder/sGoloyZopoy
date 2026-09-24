// openStore: node:sqlite connection + pragmas + migrations + all aggregate repositories.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@sgz/shared";
import { applicationsRepo } from "./applications.js";
import { careerRepo } from "./career.js";
import { chatTasksRepo, type ChatTasksRepo } from "./chat-tasks.js";
import { chatsRepo } from "./chats.js";
import { intelRepo } from "./intel.js";
import { jobsRepo, type JobsRepo } from "./jobs.js";
import { kbRepo } from "./kb.js";
import { applyMigrations } from "./migrate.js";
import { resumesRepo } from "./resumes.js";
import { runsRepo } from "./runs.js";
import { settingsRepo } from "./settings.js";
import { Sql } from "./sql.js";
import { statsRepo } from "./stats.js";
import { usersRepo } from "./users.js";
import { vacanciesRepo } from "./vacancies.js";

/** The agent's tables live next to the Store contract, not in it: only the always-on agent uses them. */
export interface SqliteStore extends Store, JobsRepo, ChatTasksRepo {
  readonly db: DatabaseSync;
  readonly path: string;
}

export function openStore(path: string): SqliteStore {
  const inMemory = path === ":memory:" || path === "";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(inMemory ? ":memory:" : path);
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  applyMigrations(db);

  const s = new Sql(db);
  return {
    db,
    path,
    close: () => db.close(),
    ...usersRepo(s),
    ...resumesRepo(s),
    ...vacanciesRepo(s),
    ...applicationsRepo(s),
    ...chatsRepo(s),
    ...careerRepo(s),
    ...runsRepo(s),
    ...statsRepo(s),
    ...settingsRepo(s),
    ...intelRepo(s),
    ...jobsRepo(s),
    ...chatTasksRepo(s),
    ...kbRepo(s),
  };
}
