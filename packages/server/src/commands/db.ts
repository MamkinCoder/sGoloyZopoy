// sgz db migrate | backup [dest] | import-profile --user <slug> [--file <path>]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { paths } from "@sgz/shared";
import { ensureDirs, loadConfig, loadProfileYaml } from "../config/index.js";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { newUserDefaults } from "../db/users.js";
import { importProfile } from "../kb/write.js";
import type { Command } from "./index.js";

const USAGE = `usage: sgz db <migrate|backup [dest]|import-profile --user <slug> [--file <path>]>`;

export const db: Command = async (args) => {
  const [sub = "", ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { user: { type: "string" }, file: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });

  const cfg = loadConfig();
  ensureDirs(cfg);
  const dbPath = paths.db(cfg);

  switch (sub) {
    case "migrate": {
      const store = openStore(dbPath);
      try {
        const created = seedDefaultUsers(store);
        console.log(`db ready: ${dbPath}`);
        if (created.length) console.log(`seeded users: ${created.map((u) => u.slug).join(", ")}`);
      } finally {
        store.close();
      }
      return;
    }
    case "backup": {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
      const dest = resolve(positionals[0] ?? `${cfg.dataDir}/backups/sgz-${ts}.db`);
      const store = openStore(dbPath);
      try {
        store.backup(dest);
      } finally {
        store.close();
      }
      console.log(`backup written: ${dest}`);
      return;
    }
    case "import-profile": {
      const slug = values.user;
      if (!slug) throw new Error(`--user <slug> is required\n${USAGE}`);
      const file = resolve(values.file ?? paths.profile(cfg, slug));
      const profile = loadProfileYaml(file);
      const store = openStore(dbPath);
      try {
        seedDefaultUsers(store);
        // First-time setup: a new slug gets a user row with default limits, named from the profile.
        const user = store.getUserBySlug(slug) ?? store.upsertUser(newUserDefaults(slug, profile.full_name.split(" ")[0] || slug));
        // profile.yaml seeds only unanswered KB tags; the lists are then written from the KB (docs/ARCHITECTURE.md §4).
        importProfile(store, user.id, profile);
      } finally {
        store.close();
      }
      console.log(`profile imported for ${slug} from ${file}`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
};
