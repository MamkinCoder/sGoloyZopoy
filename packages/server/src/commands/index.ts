// Command registry. Each workstream adds its command file and registers it here (append-only).
import { db } from "./db.js";
import { hhLogin } from "./hh-login.js";
import { habrLogin } from "./habr-login.js";
import { habrResume } from "./habr-resume.js";
import { hhRecord } from "./hh-record.js";
import { kb } from "./kb.js";
import { run } from "./run.js";
import { serve } from "./serve.js";
import { pool } from "./pool.js";
import { resume } from "./resume.js";
import { site } from "./site.js";

export type Command = (args: string[]) => Promise<void>;
export const commands: Record<string, Command> = {
  version: async () => console.log("dev"),
  run,
  serve,
  pool,
  "hh-login": hhLogin,
  "habr-login": habrLogin,
  "habr-resume": habrResume,
  "hh-record": hhRecord,
  db,
  resume,
  site,
  kb,
};
