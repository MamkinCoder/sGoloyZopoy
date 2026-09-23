// sgz habr-resume --user <slug> [--apply] [--bin <chrome>]
// Without --apply: reads the Habr profile as it is today (read-only), asks the LLM once for ONE universal
// profile built only from profile.yaml + the base CVs (+ Habr's own experience texts), guards it, maps the
// skills to Habr's dictionary and writes data/users/<slug>/habr-resume.proposal.json. Nothing is saved on Habr.
// With --apply: writes that proposal to the Habr edit pages. Run it only after the human approved the proposal.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, type BrowserSession, type Cookie } from "@sgz/shared";
import { getJson } from "../career/http.js";
import { loadConfig, loadProfileYaml } from "../config/index.js";
import { createHabrClient } from "../habr/client.js";
import { SPECIALIZATIONS, guardProposal, readHabrProfile, renderProposal, resolveHabrSkills, writeHabrProfile, type HabrResumeProposal } from "../habr/resume.js";
import { createLLM, renderPrompt } from "../llm/index.js";
import { neverClaimList, profileForLLM } from "../llm/format.js";
import { loadCV } from "../resume/yaml.js";
import { chromiumBin, loadLauncher, parseArgs, str, userAgent } from "./hh-common.js";

const SCHEMA = `\`\`\`json
{
  "title": string,                 // до 80 символов
  "specializations": number[],     // 1-2 id из списка
  "qualification": "Junior" | "Middle" | "Senior",
  "about": string,                 // 4-6 абзацев через пустую строку
  "skills": string[],              // 25-30
  "experiences": [{ "company": string, "description": string }],
  "notes": string[]
}
\`\`\``;

async function openHabr(slug: string, bin: string): Promise<BrowserSession> {
  const cfg = loadConfig();
  const mac = join(cfg.dataDir, "users", slug, "chrome-profile-habr"); // sgz habr-login's profile (Mac)
  const s = await loadLauncher().launch({
    executablePath: chromiumBin(bin),
    headless: true,
    userDataDir: existsSync(mac) ? mac : paths.chromeProfile(cfg, slug),
    userAgent: userAgent(),
    snapshotDir: paths.snapshots(cfg),
    blockAssets: true,
    cacheDir: paths.actionCache(cfg),
  });
  const habr = createHabrClient();
  if (!(await habr.checkLogin(s))) {
    const file = paths.habrCookies(cfg, slug);
    if (existsSync(file)) await s.setCookies(JSON.parse(readFileSync(file, "utf8")) as Cookie[]);
    if (!(await habr.checkLogin(s))) {
      await s.close();
      throw new Error(`Habr Career: ${slug} is not logged in; run sgz habr-login --user ${slug}`);
    }
  }
  return s;
}

export const habrResume = async (args: string[]): Promise<void> => {
  const a = parseArgs(args);
  const slug = str(a.user);
  if (!slug) throw new Error("usage: sgz habr-resume --user <slug> [--apply] [--bin <chrome>]");
  const cfg = loadConfig();
  const out = paths.habrResumeProposal(cfg, slug);

  if (a.apply) {
    if (!existsSync(out)) throw new Error(`no proposal at ${out}; run sgz habr-resume --user ${slug} first`);
    const { proposal } = JSON.parse(readFileSync(out, "utf8")) as { proposal: HabrResumeProposal };
    const s = await openHabr(slug, str(a.bin));
    try {
      for (const line of await writeHabrProfile(s, proposal)) console.log(line);
    } finally {
      await s.close();
    }
    return;
  }

  const profile = loadProfileYaml(paths.profile(cfg, slug));
  const cvDir = paths.cvDir(cfg, slug);
  const cvs = existsSync(cvDir)
    ? readdirSync(cvDir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => {
          const { contacts: _c, name: _n, photo: _p, ...cv } = loadCV(join(cvDir, f));
          return cv;
        })
    : [];
  const s = await openHabr(slug, str(a.bin));
  let current: Awaited<ReturnType<typeof readHabrProfile>>;
  try {
    current = await readHabrProfile(s);
  } finally {
    await s.close();
  }
  const prompt = renderPrompt("habr_resume", {
    never_claim: neverClaimList(profile),
    profile: profileForLLM(profile),
    cvs,
    habr_current: current.resume.companies,
    specializations: Object.entries(SPECIALIZATIONS).map(([id, t]) => `- ${id}: ${t}`).join("\n"),
  });
  console.error(`asking the LLM (${prompt.length} chars of prompt)...`);
  const raw = await createLLM(cfg, null).json<HabrResumeProposal>("habr_resume", "tailor", prompt, SCHEMA);
  const allowed = [...profile.verified_skills, ...cvs.flatMap((cv) => [...cv.skills.flatMap((g) => g.items), ...cv.jobs.flatMap((j) => j.stack)])];
  const guarded = guardProposal(raw, allowed, profile, current.resume.companies.map((c) => c.title));
  const mapped = await resolveHabrSkills(guarded.skills, (u) => getJson(u));
  const proposal: HabrResumeProposal = {
    ...guarded,
    skills: mapped.skills,
    notes: [...guarded.notes, ...mapped.missing.map((m) => `навык «${m}» не найден в словаре Хабра, не будет добавлен`)],
  };
  writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), user: slug, login: current.login, current: current.resume, proposal }, null, 2), "utf8");
  console.log(renderProposal(proposal));
  console.log(`\nпредложение: ${out}\nНичего не записано на Хабр. После одобрения: sgz habr-resume --user ${slug} --apply`);
};
