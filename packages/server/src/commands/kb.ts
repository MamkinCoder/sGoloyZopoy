// sgz kb seed --user <slug> [--dry-run [--out <file>]] [--from <file>]
// sgz kb list --user <slug> [--tag <name>]
// seed: one LLM pass over data/users/<slug>/cv/*.yaml + profile.yaml + habr-resume.proposal.json -> tags + stories
// (source seed, unconfirmed), imported into the DB by content hash: re-runs add only new stories, never delete or
// edit anything. --dry-run prints/saves the JSON without touching the DB; --from imports such a JSON without the LLM.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { paths, tagIs } from "@sgz/shared";
import { loadConfig, loadProfileYaml } from "../config/index.js";
import { openStore } from "../db/index.js";
import { renderStory } from "../kb/context.js";
import { seedKb, type SeedSources } from "../kb/llm.js";
import { applySeed, type KbSeed } from "../kb/write.js";
import { createLLM } from "../llm/index.js";
import { loadCV } from "../resume/yaml.js";
import type { Command } from "./index.js";

const USAGE = "usage: sgz kb seed --user <slug> [--dry-run [--out <file>]] [--from <file>] | sgz kb list --user <slug> [--tag <name>]";

function loadSources(slug: string): SeedSources {
  const cfg = loadConfig();
  const profile = loadProfileYaml(paths.profile(cfg, slug));
  const cvDir = paths.cvDir(cfg, slug);
  const cvs = existsSync(cvDir)
    ? readdirSync(cvDir)
        .filter((f) => f.endsWith(".yaml"))
        .sort()
        .map((f) => {
          const { contacts: _c, name: _n, photo: _p, ...cv } = loadCV(join(cvDir, f));
          return cv;
        })
    : [];
  const habrFile = paths.habrResumeProposal(cfg, slug);
  const p = existsSync(habrFile) ? (JSON.parse(readFileSync(habrFile, "utf8")) as { proposal?: Record<string, unknown> }).proposal : undefined;
  const habr = p ? { title: p.title, about: p.about, experiences: p.experiences, skills: p.skills } : null;
  return { profile, cvs, habr };
}

export const kb: Command = async (args) => {
  const [sub = "", ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: { user: { type: "string" }, "dry-run": { type: "boolean", default: false }, out: { type: "string" }, from: { type: "string" }, tag: { type: "string" } },
    strict: true,
  });
  const slug = values.user;
  if (!slug || (sub !== "seed" && sub !== "list")) throw new Error(USAGE);
  const cfg = loadConfig();

  let seed: KbSeed | null = null;
  if (sub === "seed") {
    if (values.from) seed = JSON.parse(readFileSync(resolve(values.from), "utf8")) as KbSeed;
    else {
      const src = loadSources(slug);
      console.error(`kb seed: ${src.cvs.length} CV, habr ${src.habr ? "да" : "нет"}, asking the LLM...`);
      seed = await seedKb(createLLM(cfg, null), src);
    }
    console.error(`kb seed: ${seed.tags.length} tags, ${seed.stories.length} stories`);
    if (values["dry-run"]) {
      const json = JSON.stringify({ generated_at: new Date().toISOString(), user: slug, ...seed }, null, 2);
      if (values.out) {
        writeFileSync(resolve(values.out), json, "utf8");
        console.error(`written: ${resolve(values.out)}`);
      } else console.log(json);
      return;
    }
  }

  const store = openStore(paths.db(cfg));
  try {
    const user = store.getUserBySlug(slug);
    if (!user) throw new Error(`user not found: ${slug}`);
    if (seed) {
      const r = applySeed(store, user.id, seed);
      console.log(`kb seed ${slug}: +${r.tagsAdded} tags, +${r.storiesAdded} stories, ${r.storiesSkipped} already present`);
      return;
    }
    const tags = store.listKbTags(user.id);
    if (values.tag) {
      const tag = tags.find((t) => tagIs(t, values.tag!));
      if (!tag) throw new Error(`tag not found: ${values.tag}`);
      console.log(`${tag.name} [${tag.status}] ${tag.aliases.join(", ")}\n`);
      console.log(store.listKbStories(user.id, tag.id).map(renderStory).join("\n\n") || "(нет историй)");
      return;
    }
    for (const t of tags) console.log(`${t.status.padEnd(7)} ${String(t.storyCount).padStart(3)}  ${t.name}${t.category ? ` (${t.category})` : ""}${t.aliases.length ? `  ~ ${t.aliases.join(", ")}` : ""}`);
    const stories = store.listKbStories(user.id);
    console.log(`\n${tags.length} tags, ${stories.length} stories (${stories.filter((s) => s.confirmed).length} confirmed)`);
  } finally {
    store.close();
  }
};
