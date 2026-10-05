// `/cv` Telegram command: a hand-pasted vacancy → tailored CV PDF + cover letter, delivered to the chat.
// It reuses the exact autopilot pipeline (tailorToPdf → llm.tailorCV / llm.coverLetterCareer, which run
// `claude -p` with cwd=repoDir so CLAUDE.md + .claude/skills drive the rewrite), so a pasted vacancy gets
// the same resume the batch runner would build — nothing is auto-submitted anywhere.
import { existsSync } from "node:fs";
import { errMessage, notifierFor, paths, type Config, type Notifier, type Profile, type User } from "@sgz/shared";
import { makeVacancy } from "../career/vacancy.js";
import { loadCV } from "../resume/yaml.js";
import { tailorToPdf, type TailorPipelineDeps } from "./tailor-pipeline.js";

export interface ManualCVDeps extends TailorPipelineDeps {
  notifier: Notifier;
}

const ROLE_RE = /разработчик|разработка|developer|программист|engineer|инженер|фронтенд|frontend|front-end|backend|бэкенд|back-end|fullstack|full-stack|фулстек|фуллстек|девопс|devops|sre|аналитик|analyst|data|ml|qa|тестировщик/i;

/** Best-effort title/company from a pasted posting: skip hashtag/emoji headers, take the first role-like
 *  line as the title and the line just above it as the company. The full text is always the description. */
export function parseVacancyText(text: string): { title: string; company: string; descriptionText: string } {
  const clean = text.trim();
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // drop lines that are only hashtags/emoji/separators (e.g. "#junior #middle #удаленка", "☑️ ...")
    .filter((l) => !/^[#@]/.test(l) && /\p{L}/u.test(l.replace(/[#@][\p{L}\d_]+/gu, "").trim()));
  const head = lines.slice(0, 6);
  const trim = (s: string, n: number) => s.replace(/^[\s\-–—•*·|]+/, "").replace(/[\s|]+$/, "").slice(0, n);
  const idx = head.findIndex((l) => ROLE_RE.test(l) && l.length <= 100);
  const title = idx >= 0 ? head[idx]! : head[0] ?? "Вакансия";
  const company = idx > 0 ? head[idx - 1]! : "";
  return { title: trim(title, 120), company: trim(company, 80), descriptionText: clean };
}

/** Pick the base CV (data/users/<slug>/cv/base-<direction>.yaml) whose real skills/stack overlap the
 *  vacancy text most; ties fall back to the profile's own direction order. Returns null when none exist. */
export function pickBaseCV(cfg: Config, slug: string, directions: string[], vacancyText: string): { path: string; direction: string } | null {
  const dir = paths.cvDir(cfg, slug);
  const candidates = [...directions.map((d) => ({ d, p: `${dir}/base-${d}.yaml` })), { d: "", p: `${dir}/base.yaml` }].filter((c) => existsSync(c.p));
  if (!candidates.length) return null;
  const hay = vacancyText.toLowerCase();
  let best: { path: string; direction: string } | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    let score = 0;
    try {
      const cv = loadCV(c.p);
      const terms = new Set<string>();
      for (const g of cv.skills) for (const it of g.items) terms.add(it.toLowerCase());
      for (const j of cv.jobs) for (const s of j.stack) terms.add(s.toLowerCase());
      for (const t of terms) if (t.length >= 2 && hay.includes(t)) score++;
    } catch {
      continue; // unreadable/invalid CV: skip, don't let one bad file sink the command
    }
    if (score > bestScore) {
      bestScore = score;
      best = { path: c.p, direction: c.d };
    }
  }
  return best;
}

/** `<Last>_<First>_CV.pdf` (Cyrillic kept; only path-unsafe characters replaced) — the name recruiters see. */
function cvFileName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const stem = parts.length >= 2 ? `${parts[1]}_${parts[0]}` : parts[0] || "CV";
  return `${stem}_CV.pdf`.replace(/[\\/:*?"<>|]+/g, "_");
}

/** Run the shared pipeline for a pasted vacancy and push the PDF + cover letter to the seeker's chat.
 *  Called in the background by the `/cv` handler, so it reports its own errors instead of throwing. */
export async function generateManualCV(
  deps: ManualCVDeps,
  input: { user: User; profile: Profile; base: { path: string; direction: string }; parsed: { title: string; company: string; descriptionText: string } },
): Promise<void> {
  const target = notifierFor(deps.notifier, input.user);
  try {
    const base = loadCV(input.base.path);
    const vacancy = deps.store.upsertVacancy(
      makeVacancy({ source: "manual", externalId: `manual-${input.user.id}-${Date.now()}`, url: "", title: input.parsed.title || "Вакансия", company: input.parsed.company, descriptionText: input.parsed.descriptionText }),
    );
    // Identical to the autopilot: tailorToPdf owns tier, KB, lessons and the never-claim guard.
    const outPdf = `${paths.generatedDir(deps.cfg, input.user.slug)}/manual-${vacancy.id}-${Date.now()}.pdf`;
    const result = await tailorToPdf(deps, { user: input.user, profile: input.profile, base, vacancy, outPdf });
    if (!result.ok) {
      await target.alert?.("CV", `Не собрал резюме под «${vacancy.title}»: ${result.violations.join("; ")}`);
      return;
    }
    const caption = `${vacancy.title}${vacancy.company ? ` - ${vacancy.company}` : ""}`.slice(0, 1000);
    await target.document?.({ path: result.pdfPath, filename: cvFileName(input.profile.full_name), caption });
    await target.ask?.(result.coverLetter, []);
    if (result.changes.length) await target.ask?.(`Правки под вакансию:\n${result.changes.map((c) => `- ${c}`).join("\n")}`, []);
  } catch (e) {
    await target.alert?.("CV", `Ошибка при сборке резюме: ${errMessage(e)}`);
  }
}
