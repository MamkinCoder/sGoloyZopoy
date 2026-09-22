// LLMClient over `claude -p`: template → claude → zod → deterministic guards. One process at a time.
import type {
  Answer,
  CV,
  ChatMessage,
  ChatReply,
  Config,
  DecideInput,
  Decision,
  HHResume,
  LLMClient,
  PoolVariant,
  Profile,
  Question,
  ResumeSummary,
  StagehandLLM,
  Store,
  Tier,
  Vacancy,
} from "@sgz/shared";
import { z, type ZodType } from "zod";
import { ClaudeError, DEFAULT_TIMEOUT_MS, TIER_MODEL, extractJson, runClaude } from "./claude.js";
import { neverClaimList, profileForLLM, renderHistory, renderQuestions, renderResumes, renderVacancies, renderVacancy } from "./format.js";
import { LIMITS, ensureDecisions, enforceMax, normalizeProse, sanitizeLetter, stripNeverClaimSentences } from "./guards.js";
import {
  AnswersSchema,
  ChatReplySchema,
  CoverLetterSchema,
  DecisionsSchema,
  PoolVariantsSchema,
  ResumeSummarySchema,
  TailorSchema,
  unwrapArray,
} from "./schemas.js";
import { stagehandAdapter, stagehandTier } from "./stagehand.js";
import { guardTailoredCV } from "./tailor.js";
import { renderPrompt } from "./template.js";

export { renderPrompt } from "./template.js";
export { FakeLLM } from "./fake.js";
export { extractJson } from "./claude.js";

export const DECIDE_BATCH = 10;
export const RESUME_TEXT_MAX = 6000;
const RETRY_SUFFIX = "\n\nВерни ТОЛЬКО JSON по схеме, без текста до и после.";

export interface LLMOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Pass zod-derived `--json-schema` for object outputs when the binary supports it (default true). */
  useJsonSchema?: boolean;
}

interface Ctx {
  cfg: Config;
  store: Store | null;
  opts: LLMOptions;
  runId: number | null;
}

interface CallOpts<T> {
  task: string;
  tier: Tier;
  prompt: string;
  schema: ZodType<T>;
  array?: boolean;
  jsonSchema?: unknown;
}

export function createLLM(cfg: Config, store: Store | null, opts: LLMOptions = {}): LLMClient {
  return makeClient({ cfg, store, opts, runId: null });
}

async function invoke(ctx: Ctx, task: string, tier: Tier, prompt: string, attempt: number, jsonSchema?: unknown) {
  const started = Date.now();
  const log = (ok: boolean, resultChars: number, error: string, durationMs: number) =>
    ctx.store?.insertLLMCall({ runId: ctx.runId, task, model: TIER_MODEL[tier], promptChars: prompt.length, resultChars, durationMs, ok, error, attempt });
  try {
    const r = await runClaude({
      bin: ctx.cfg.claudeBin || "claude",
      cwd: ctx.cfg.repoDir,
      tier,
      prompt,
      timeoutMs: ctx.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      schema: ctx.opts.useJsonSchema === false ? undefined : jsonSchema,
      env: ctx.opts.env,
    });
    return { r, log };
  } catch (err) {
    const e = err instanceof ClaudeError ? err : new ClaudeError(String(err), -1, "", Date.now() - started);
    log(false, 0, e.message.slice(0, 500), e.durationMs);
    throw e;
  }
}

/** Render → claude → parse → validate, retrying once with a "JSON only" nudge. */
async function call<T>(ctx: Ctx, o: CallOpts<T>): Promise<T> {
  let prompt = o.prompt;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { r, log } = await invoke(ctx, o.task, o.tier, prompt, attempt, o.jsonSchema);
    try {
      let raw = r.structured !== undefined ? r.structured : extractJson(r.text);
      if (o.array) raw = unwrapArray(raw);
      const parsed = o.schema.safeParse(raw);
      if (!parsed.success) throw new Error(`schema: ${z.prettifyError(parsed.error).slice(0, 300)}`);
      log(true, r.text.length, "", r.durationMs);
      return parsed.data;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      log(false, r.text.length, lastErr.slice(0, 500), r.durationMs);
      prompt = o.prompt + RETRY_SUFFIX;
    }
  }
  throw new Error(`llm ${o.task}: invalid output after retry: ${lastErr}`);
}

function toJsonSchema(schema: ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: "output" });
  } catch {
    return undefined;
  }
}

function makeClient(ctx: Ctx): LLMClient {
  const client: LLMClient = {
    async decide(input: DecideInput): Promise<Decision[]> {
      const out: Decision[] = [];
      for (let i = 0; i < input.vacancies.length; i += DECIDE_BATCH) {
        const batch = input.vacancies.slice(i, i + DECIDE_BATCH);
        out.push(...(await decideBatch(ctx, input.profile, input.resumes, batch)));
      }
      return out;
    },

    async answerQuestionnaire(profile: Profile, vacancy: Vacancy | null, qs: Question[]): Promise<Answer[]> {
      if (!qs.length) return [];
      const prompt = renderPrompt("answer_questionnaire", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile, { contacts: true }),
        vacancy: vacancy ? renderVacancy(vacancy) : "",
        questions: renderQuestions(qs),
      });
      const answers = await call(ctx, { task: "answer_questionnaire", tier: "write", prompt, schema: AnswersSchema, array: true });
      return guardAnswers(qs, answers, profile.never_claim_skills);
    },

    async answerChat(profile: Profile, vacancy: Vacancy | null, history: ChatMessage[]): Promise<ChatReply> {
      const prompt = renderPrompt("answer_chat", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        vacancy: vacancy ? renderVacancy(vacancy, 1500) : "",
        history: renderHistory(history),
      });
      const r = await call(ctx, { task: "answer_chat", tier: "write", prompt, schema: ChatReplySchema, jsonSchema: toJsonSchema(ChatReplySchema) });
      const reply = r.needs_human ? "" : sanitizeLetter(r.reply, profile.never_claim_skills, LIMITS.chatReply);
      return { reply, needs_human: r.needs_human, reason: enforceMax(r.reason, LIMITS.reason) };
    },

    async summarizeResume(resumeText: string): Promise<ResumeSummary> {
      const prompt = renderPrompt("summarize_resume", { resume_text: resumeText.slice(0, RESUME_TEXT_MAX) });
      const s = await call(ctx, { task: "summarize_resume", tier: "fast", prompt, schema: ResumeSummarySchema, jsonSchema: toJsonSchema(ResumeSummarySchema) });
      return { ...s, key_skills: s.key_skills.slice(0, 12), one_line: enforceMax(s.one_line, 200) };
    },

    async proposePoolVariants(profile: Profile, existing: HHResume[], max: number): Promise<PoolVariant[]> {
      const prompt = renderPrompt("propose_pool_variants", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        existing: renderResumes(existing),
        max,
      });
      const variants = await call(ctx, { task: "propose_pool_variants", tier: "write", prompt, schema: PoolVariantsSchema, array: true });
      return guardVariants(profile, existing, variants, max);
    },

    async tailorCV(profile: Profile, base: CV, vacancy: Vacancy, tier: Tier = "write"): Promise<{ cv: CV; changes: string[] }> {
      const prompt = renderPrompt("tailor_cv", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        cv: base,
        vacancy: renderVacancy(vacancy, 6000),
      });
      const r = await call(ctx, { task: "tailor_cv", tier, prompt, schema: TailorSchema, jsonSchema: toJsonSchema(TailorSchema) });
      const { cv, dropped } = guardTailoredCV(profile, base, r.cv);
      const changes = r.changes.map((c) => enforceMax(normalizeProse(c), 200)).filter(Boolean);
      if (dropped.length) changes.push(`guard: убраны неподтверждённые технологии: ${[...new Set(dropped)].join(", ")}`);
      return { cv, changes };
    },

    async coverLetterCareer(profile: Profile, cv: CV, vacancy: Vacancy): Promise<string> {
      const prompt = renderPrompt("cover_letter_career", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        cv,
        vacancy: renderVacancy(vacancy, 6000),
      });
      const r = await call(ctx, { task: "cover_letter_career", tier: "write", prompt, schema: CoverLetterSchema, jsonSchema: toJsonSchema(CoverLetterSchema) });
      return sanitizeLetter(r.cover_letter, profile.never_claim_skills, LIMITS.coverLetterCareer);
    },

    async json<T>(task: string, tier: Tier, prompt: string, schemaDescription: string): Promise<T> {
      const full = `${prompt.trimEnd()}\n\n## Схема ответа\n\n${schemaDescription.trim()}\n\nВерни только JSON.\n`;
      return call(ctx, { task, tier, prompt: full, schema: z.unknown() as ZodType<T> });
    },

    stagehand(): StagehandLLM {
      return stagehandAdapter(async (req) => {
        const { r, log } = await invoke(ctx, "stagehand", req.tier, req.prompt, 1, req.schema);
        log(true, r.text.length, "", r.durationMs);
        return { text: r.text, structured: r.structured };
      }, stagehandTier());
    },

    withRun(runId: number | null): LLMClient {
      return makeClient({ ...ctx, runId });
    },
  };
  return client;
}

async function decideBatch(ctx: Ctx, profile: Profile, resumes: HHResume[], vacancies: Vacancy[]): Promise<Decision[]> {
  if (!vacancies.length) return [];
  const prompt = renderPrompt("decide_hh", {
    never_claim: neverClaimList(profile),
    profile: profileForLLM(profile),
    resumes: renderResumes(resumes),
    vacancies: renderVacancies(vacancies),
    count: vacancies.length,
  });
  let decisions: Decision[] = [];
  try {
    decisions = await call(ctx, { task: "decide_hh", tier: "fast", prompt, schema: DecisionsSchema, array: true });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("invalid output")) throw err;
    // Two garbage answers: rather than failing the whole run, skip this batch with "no decision".
  }
  return ensureDecisions(vacancies, decisions, resumes, profile.never_claim_skills);
}

function guardAnswers(qs: Question[], answers: Answer[], never: string[]): Answer[] {
  const byIdx = new Map(qs.map((q) => [q.idx, q]));
  const seen = new Set<number>();
  const out: Answer[] = [];
  for (const a of answers) {
    const q = byIdx.get(a.idx);
    if (!q || seen.has(a.idx)) continue;
    seen.add(a.idx);
    const n = q.options?.length ?? 0;
    const clean: Answer = { idx: a.idx };
    if (a.text !== undefined) clean.text = enforceMax(stripNeverClaimSentences(normalizeProse(a.text), never), LIMITS.questionnaireText);
    if (a.option_idx !== undefined && a.option_idx >= 0 && a.option_idx < n) clean.option_idx = a.option_idx;
    if (a.option_idxs) {
      const ids = [...new Set(a.option_idxs.filter((i) => i >= 0 && i < n))];
      if (ids.length) clean.option_idxs = ids;
    }
    out.push(clean);
  }
  return out;
}

function guardVariants(profile: Profile, existing: HHResume[], variants: PoolVariant[], max: number): PoolVariant[] {
  const verified = new Map(profile.verified_skills.map((s) => [s.toLowerCase(), s]));
  const titles = new Set(existing.map((r) => r.title.trim().toLowerCase()));
  const poolIds = new Set(existing.map((r) => r.hhResumeId));
  const out: PoolVariant[] = [];
  for (const v of variants) {
    const key = v.title.trim().toLowerCase();
    if (!key || titles.has(key)) continue;
    titles.add(key);
    out.push({
      title: normalizeProse(v.title),
      about: sanitizeLetter(v.about, profile.never_claim_skills, LIMITS.about),
      key_skills: [...new Set(v.key_skills.map((s) => verified.get(s.trim().toLowerCase())).filter((s): s is string => !!s))],
      based_on_resume_id: poolIds.has(v.based_on_resume_id) ? v.based_on_resume_id : (existing[0]?.hhResumeId ?? ""),
      direction: profile.directions.includes(v.direction) ? v.direction : (profile.directions[0] ?? v.direction),
    });
    if (out.length >= max) break;
  }
  return out;
}
