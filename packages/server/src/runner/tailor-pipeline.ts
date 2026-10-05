// The ONE place a CV gets tailored to a vacancy. Both the autopilot (career runner's queueVacancy) and
// the Telegram /cv command call tailorToPdf and nothing else: it owns the whole recipe — which model
// tier, which KB stories and lessons to feed in, the never-claim guard, rendering and the cover letter.
// The LLM calls run `claude -p` with cwd=repoDir, so CLAUDE.md + .claude/skills drive the rewrite.
// Keep this the single source of truth: callers must not re-assemble any of this around it.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CV, Config, LLMClient, Profile, Store, Tier, User, Vacancy } from "@sgz/shared";
import { paths } from "@sgz/shared";
import { kbBrief, kbForVacancy, withKbNever } from "../kb/context.js";
import type { ResumeDeps } from "./deps.js";
import { readLessons } from "./learn.js";

export interface TailorPipelineDeps {
  llm: LLMClient;
  resume: ResumeDeps;
  store: Store;
  cfg: Config;
}

export interface TailorPipelineInput {
  user: Pick<User, "id" | "opusEnabled">;
  profile: Profile;
  base: CV;
  /** Already persisted (store.upsertVacancy): vacancy.id names the output files. */
  vacancy: Vacancy;
  outPdf: string;
  /** Runner-only guards (memory budget / abort / stats); the one-off /cv command omits them. */
  hooks?: {
    guard?: (stage: "tailor" | "build") => void | Promise<void>;
    checkAbort?: () => void;
    onLlmCall?: () => void;
  };
}

export type TailorPipelineResult =
  | { ok: true; cv: CV; changes: string[]; pdfPath: string; texPath: string; generatedResumeId: number; coverLetter: string }
  | { ok: false; reason: "validation"; violations: string[] };

/** The model tier a user's CVs are written with: opus when they have it on, otherwise sonnet. */
export const tierFor = (user: Pick<User, "opusEnabled">): Tier => (user.opusEnabled ? "tailor" : "write");

/**
 * tailor → validate → render → PDF → store the generated row → cover letter, assembling the KB brief,
 * lessons, tier and never-claim guard itself. A validation miss is returned (`ok: false`), not thrown; a
 * LaTeX or LLM failure throws so the caller can map it (the runner to FAILED_LATEX / FAILED_LLM).
 */
export async function tailorToPdf(deps: TailorPipelineDeps, input: TailorPipelineInput): Promise<TailorPipelineResult> {
  const { llm, resume, store, cfg } = deps;
  const { user, profile, base, vacancy, outPdf } = input;
  const { guard, checkAbort, onLlmCall } = input.hooks ?? {};

  const tier = tierFor(user);
  // The KB for the CV: only stories of the base CV's own companies (bullet material, never a new job).
  const tailorKb = kbBrief(store, user.id, { text: `${vacancy.title}\n${vacancy.descriptionText}`, companies: base.jobs.map((j) => j.company) });

  await guard?.("tailor");
  const t = await llm.tailorCV(profile, base, vacancy, tier, tailorKb);
  onLlmCall?.();
  checkAbort?.();

  const cv = t.cv;
  const violations = resume.validateCV(base, cv, withKbNever(profile, tailorKb).never_claim_skills);
  if (violations.length) return { ok: false, reason: "validation", violations };

  const tex = resume.renderTex(cv);
  await guard?.("build");
  try {
    mkdirSync(dirname(outPdf), { recursive: true });
  } catch {
    /* fake fs in tests / read-only dir: buildPdf will report */
  }
  const built = await resume.buildPdf({ tex, texDir: paths.texDir(cfg), outPdf, xelatexBin: cfg.xelatexBin });
  checkAbort?.();

  const generatedResumeId = store.insertGeneratedResume({ userId: user.id, vacancyId: vacancy.id, texPath: built.texPath, pdfPath: built.pdfPath, model: tier }).id;
  const coverLetter = await llm.coverLetterCareer(profile, cv, vacancy, readLessons(store, user.id).lessons, kbForVacancy(store, user.id, vacancy));
  onLlmCall?.();
  checkAbort?.();

  return { ok: true, cv, changes: t.changes, pdfPath: built.pdfPath, texPath: built.texPath, generatedResumeId, coverLetter };
}
