// sgz user on|off <slug> | list — master switch per user, usable before `sgz serve` starts.
// Inactive users get no scheduled runs, chat sync, auto-replies or Google-form answers.
import { paths } from "@sgz/shared";
import { loadConfig } from "../config/index.js";
import { openStore } from "../db/index.js";
import type { Command } from "./index.js";

export const user: Command = async ([sub = "", slug = ""]) => {
  const store = openStore(paths.db(loadConfig()));
  try {
    if (sub === "list") {
      for (const u of store.listUsers()) console.log(`${u.active ? "on " : "off"}  ${u.slug}  ${u.name}`);
      return;
    }
    if ((sub !== "on" && sub !== "off") || !slug) throw new Error("usage: sgz user <on|off> <slug> | sgz user list");
    const u = store.getUserBySlug(slug);
    if (!u) throw new Error(`no user ${slug}`);
    store.upsertUser({ ...u, active: sub === "on" });
    console.log(`${slug}: ${sub}`);
  } finally {
    store.close();
  }
};
