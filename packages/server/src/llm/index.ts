// LLMClient over `claude -p`: template → claude → zod → deterministic guards. One process at a time.
import { companyKey } from "@sgz/shared";
import type {
  Answer,
  CV,
  ChatMessage,
  ChatReply,
  ChatTriage,
  Config,
  DecideInput,
  Decision,
  HHResume,
  InterviewPrep,
  KbBrief,
  LLMClient,
  PoolVariant,
  Profile,
  Question,
  ResumeSummary,
  StagehandLLM,
  StudyItem,
  Store,
  Tier,
  Vacancy,
} from "@sgz/shared";
import { z, type ZodType } from "zod";
import { ClaudeError, TIER_MODEL, extractJson, runClaude } from "./claude.js";
import { neverClaimList, profileForLLM, renderHistory, renderQuestions, renderResumes, renderVacancies, renderVacancy } from "./format.js";
import { LIMITS, blockedTech, claimRegex, ensureDecisions, enforceMax, normalizeProse, sanitizeLetter, stripLinkSentences, stripNeverClaimSentences } from "./guards.js";
import {
  AnswersSchema,
  ChatReplySchema,
  ChatTriageSchema,
  CoverLetterSchema,
  DecisionsSchema,
  InterviewPrepSchema,
  PoolVariantsSchema,
  ResumeSummarySchema,
  StudyChecklistSchema,
  TailorSchema,
  unwrapArray,
} from "./schemas.js";
import { stagehandAdapter, stagehandTier } from "./stagehand.js";
import { guardTailoredCV } from "./tailor.js";
import { renderPrompt } from "./template.js";
import { withKbNever } from "../kb/context.js";

export { renderPrompt } from "./template.js";

const DECIDE_BATCH = 5; // smaller batches: faster calls on the Pi, a failed batch loses less
const DECIDE_PARALLEL = Math.max(1, Number(process.env.SGZ_DECIDE_PARALLEL ?? 2) || 1);
const RESUME_TEXT_MAX = 6000;
const RETRY_SUFFIX = "\n\nВерни ТОЛЬКО JSON по схеме, без текста до и после.";

export interface LLMOptions {
  env?: Record<string, string>;
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
      schema: jsonSchema,
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
    return z.toJSONSchema(schema, { io: "output" }); // buildArgs drops the "$schema" tag
  } catch {
    return undefined;
  }
}

function makeClient(ctx: Ctx): LLMClient {
  return {
    async decide(input: DecideInput): Promise<Decision[]> {
      const batches: Vacancy[][] = [];
      for (let i = 0; i < input.vacancies.length; i += DECIDE_BATCH) batches.push(input.vacancies.slice(i, i + DECIDE_BATCH));
      // A few `claude -p` at once (the browser is closed during decide); order of results is kept.
      const results: Decision[][] = new Array(batches.length);
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const i = next++;
          results[i] = await decideBatch(ctx, input, batches[i]!);
        }
      };
      await Promise.all(Array.from({ length: Math.min(DECIDE_PARALLEL, batches.length) }, worker));
      return results.flat();
    },

    async answerQuestionnaire(p: Profile, vacancy: Vacancy | null, qs: Question[], kb?: KbBrief): Promise<Answer[]> {
      if (!qs.length) return [];
      const profile = withKbNever(p, kb);
      const prompt = renderPrompt("answer_questionnaire", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile, { contacts: true }),
        vacancy: vacancy ? renderVacancy(vacancy) : "",
        questions: renderQuestions(qs),
        kb: kb?.text,
      });
      const answers = await call(ctx, { task: "answer_questionnaire", tier: "write", prompt, schema: AnswersSchema, array: true });
      return guardAnswers(qs, answers, blockedTech(profile));
    },

    async answerChat(p: Profile, vacancy: Vacancy | null, history: ChatMessage[], choices: string[] = [], kb?: KbBrief): Promise<ChatReply> {
      const profile = withKbNever(p, kb);
      const prompt = renderPrompt("answer_chat", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        vacancy: vacancy ? renderVacancy(vacancy, 1500) : "",
        history: renderHistory(history),
        choices: choices.map((c) => `- ${c}`).join("\n"),
        kb: kb?.text,
      });
      const r = await call(ctx, { task: "answer_chat", tier: "write", prompt, schema: ChatReplySchema, jsonSchema: toJsonSchema(ChatReplySchema) });
      // A reply may go out together with needs_human (e.g. «да, пришлите тестовое» + ping the human);
      // unknown skills hold the reply until the human answers in Telegram.
      const unknown_skills = r.unknown_skills.map((s) => s.trim()).filter(Boolean).slice(0, 5);
      const reason = enforceMax(r.reason, LIMITS.reason);
      const at = r.interview_at ? new Date(r.interview_at) : null;
      const interview_at = at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
      if (choices.length && !unknown_skills.length) {
        // Quick-reply buttons: only an exact option is accepted by the employer's chat bot.
        // An empty reply (offer, documents, rejection) presses nothing; a loose match counts only when it is unambiguous.
        const norm = (s: string) => s.trim().toLowerCase().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
        const want = norm(r.reply);
        if (!want) return { reply: "", needs_human: r.needs_human, reason, unknown_skills, interview_at };
        // Whole words only: «Да» must not match inside «когда».
        const loose = choices.filter((c) => !!norm(c) && (claimRegex([norm(c)])!.test(want) || claimRegex([want])!.test(norm(c))));
        const picked = choices.find((c) => norm(c) === want) ?? (loose.length === 1 ? loose[0] : undefined);
        return picked
          ? { reply: picked, needs_human: r.needs_human, reason, unknown_skills, interview_at }
          : { reply: "", needs_human: true, reason: enforceMax(`не выбрал вариант из кнопок: ${r.reply}`, LIMITS.reason), unknown_skills, interview_at };
      }
      const reply = unknown_skills.length ? "" : sanitizeLetter(r.reply, blockedTech(profile), LIMITS.chatReply);
      return { reply, needs_human: r.needs_human, reason, unknown_skills, interview_at };
    },

    async triageChat(profile: Profile, history: ChatMessage[], fresh: ChatMessage[]): Promise<ChatTriage> {
      const prompt = renderPrompt("triage_chat", {
        verified: profile.verified_skills.join(", ") || "(список пуст)",
        never_claim: neverClaimList(profile),
        history: renderHistory(history.slice(-20)),
        fresh: renderHistory(fresh),
      });
      const r = await call(ctx, { task: "triage_chat", tier: "fast", prompt, schema: ChatTriageSchema, jsonSchema: toJsonSchema(ChatTriageSchema) });
      // One entry per skill, case-insensitive; a model that lists the whole vacancy stack is cut at 6.
      const seen = new Set<string>();
      const topics = r.topics
        .map((t) => enforceMax(normalizeProse(t), 40))
        .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
        .slice(0, 6);
      return { kind: r.kind, topics };
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

    async tailorCV(p: Profile, base: CV, vacancy: Vacancy, tier: Tier = "write", kb?: KbBrief): Promise<{ cv: CV; changes: string[] }> {
      const profile = withKbNever(p, kb);
      const prompt = renderPrompt("tailor_cv", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        cv: base,
        vacancy: renderVacancy(vacancy, 6000),
        kb: kb?.text,
      });
      const r = await call(ctx, { task: "tailor_cv", tier, prompt, schema: TailorSchema, jsonSchema: toJsonSchema(TailorSchema) });
      const { cv, dropped } = guardTailoredCV(profile, base, r.cv);
      const changes = r.changes.map((c) => enforceMax(normalizeProse(c), 200)).filter(Boolean);
      if (dropped.length) changes.push(`guard: убраны неподтверждённые технологии: ${[...new Set(dropped)].join(", ")}`);
      return { cv, changes };
    },

    async coverLetterCareer(p: Profile, cv: CV, vacancy: Vacancy, lessons?: string[], kb?: KbBrief): Promise<string> {
      const profile = withKbNever(p, kb);
      const prompt = renderPrompt("cover_letter_career", {
        lessons: bullets(lessons),
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        cv: { ...cv, contacts: undefined }, // no email/phone/github for the model to copy into the letter
        vacancy: renderVacancy(vacancy, 6000),
        kb: kb?.text,
      });
      const r = await call(ctx, { task: "cover_letter_career", tier: "write", prompt, schema: CoverLetterSchema, jsonSchema: toJsonSchema(CoverLetterSchema) });
      return sanitizeLetter(r.cover_letter, blockedTech(profile), LIMITS.coverLetterCareer);
    },

    async interviewPrep(p: Profile, vacancy: Vacancy, invitation: string, kb?: KbBrief): Promise<InterviewPrep> {
      const profile = withKbNever(p, kb);
      const prompt = renderPrompt("interview_prep", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        vacancy: renderVacancy(vacancy, 3000),
        invitation: invitation.slice(0, 1500) || "(без текста)",
        kb: kb?.text,
      });
      const r = await call(ctx, { task: "interview_prep", tier: "write", prompt, schema: InterviewPrepSchema, jsonSchema: toJsonSchema(InterviewPrepSchema) });
      // Read by the seeker only, still no invented experience: stories lose never-claim sentences.
      const line = (t: string) => enforceMax(normalizeProse(t), 300);
      const lines = (xs: string[], n: number) => xs.map(line).filter(Boolean).slice(0, n);
      return {
        questions: lines(r.questions, 7),
        stories: r.stories
          .map((st) => ({ skill: line(st.skill), prompt: stripNeverClaimSentences(line(st.prompt), blockedTech(profile)) }))
          .filter((st) => st.skill && st.prompt)
          .slice(0, 3),
        gaps: lines(r.gaps, 6),
        ask_them: lines(r.ask_them, 3),
      };
    },

    async interviewStudy(p: Profile, vacancy: Vacancy, prep: InterviewPrep | null, kb?: KbBrief): Promise<StudyItem[]> {
      const profile = withKbNever(p, kb);
      const prompt = renderPrompt("interview_study", {
        never_claim: neverClaimList(profile),
        profile: profileForLLM(profile),
        vacancy: renderVacancy(vacancy, 4000),
        prep: prep ? renderPrep(prep) : "(нет)",
        kb: kb?.text,
      });
      const r = await call(ctx, { task: "interview_study", tier: "write", prompt, schema: StudyChecklistSchema, jsonSchema: toJsonSchema(StudyChecklistSchema) });
      return guardStudy(profile, r.checklist);
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
}

async function decideBatch(ctx: Ctx, input: DecideInput, vacancies: Vacancy[]): Promise<Decision[]> {
  if (!vacancies.length) return [];
  const { resumes } = input;
  const kb = input.kb?.(vacancies);
  const profile = withKbNever(input.profile, kb);
  // Only the employers of this batch; the map already holds just the ones past the min-N gate.
  const history = [...new Set(vacancies.map((v) => input.companyHistory?.[companyKey(v.company)]).filter(Boolean))];
  const prompt = renderPrompt("decide_hh", {
    never_claim: neverClaimList(profile),
    profile: profileForLLM(profile),
    resumes: renderResumes(resumes),
    vacancies: renderVacancies(vacancies),
    count: vacancies.length,
    company_history: bullets(history),
    resume_stats: bullets(input.resumeStats),
    lessons: bullets(input.lessons),
    kb: kb?.text,
  });
  let decisions: Decision[] = [];
  try {
    decisions = await call(ctx, { task: "decide_hh", tier: "write", prompt, schema: DecisionsSchema, array: true });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("invalid output")) throw err;
    // Two garbage answers: rather than failing the whole run, skip this batch with "no decision".
  }
  return ensureDecisions(vacancies, decisions, resumes, blockedTech(profile)).map((d) => guardTailored(profile, d));
}

const renderPrep = (p: InterviewPrep): string =>
  [...p.questions.map((q) => `- вопрос: ${q}`), ...p.gaps.map((g) => `- пробел: ${g}`)].join("\n") || "(пусто)";

const STUDY_LEVELS = ["must", "likely", "nice"] as const;

// Links only: tech names with dots and slashes («Node.js/Express», «ASP.NET», «Socket.io») are fine in a checklist;
// a bare host counts with a path or when it is a known site.
const STUDY_LINK_RE =
  /https?:\/\/|www\.|t\.me\/|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(?:ru|com|org|net|io|dev|me|app)\/|\b(?:github|gitlab|habr|leetcode|youtube|stackoverflow|medium|stepik|coursera|udemy)\.(?:com|ru|org|io)\b/i;

/** No links, one line per field, never-claim topics always marked as gaps, must → likely → nice, at most 20. */
export function guardStudy(profile: Profile, items: StudyItem[]): StudyItem[] {
  const never = claimRegex(profile.never_claim_skills);
  const line = (t: string, max: number) => {
    const s = enforceMax(normalizeProse(t.replace(/\s*\n\s*/g, " ")), max);
    return STUDY_LINK_RE.test(s) ? "" : s;
  };
  const seen = new Set<string>();
  const out: StudyItem[] = [];
  for (const it of items) {
    const topic = line(it.topic, 120);
    if (!topic || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    out.push({ topic, why: line(it.why, 200), level: it.level, gap: it.gap || !!never?.test(topic), study: line(it.study, 200) });
  }
  return out.sort((a, b) => STUDY_LEVELS.indexOf(a.level) - STUDY_LEVELS.indexOf(b.level)).slice(0, 20);
}

const bullets = (xs: (string | undefined)[] = []): string => xs.filter(Boolean).map((x) => `- ${x}`).join("\n");

/** `tailored` survives only for an approved poor fit with a usable title; skills ⊆ verified_skills. */
function guardTailored(profile: Profile, d: Decision): Decision {
  const { tailored, ...rest } = d;
  const fit = d.resume_fit ?? "good";
  if (!d.apply || fit !== "poor" || !tailored) return { ...rest, resume_fit: fit };
  const edit = cleanResumeEdit(profile, tailored);
  return edit.title ? { ...rest, resume_fit: fit, tailored: { ...edit, key_skills: edit.key_skills.slice(0, 15) } } : { ...rest, resume_fit: fit };
}

function cleanResumeEdit(profile: Profile, e: { title: string; about: string; key_skills: string[] }) {
  const verified = new Map(profile.verified_skills.map((s) => [s.toLowerCase(), s]));
  return {
    title: stripNeverClaimSentences(stripLinkSentences(normalizeProse(e.title)), blockedTech(profile)),
    about: sanitizeLetter(e.about, blockedTech(profile), LIMITS.about),
    key_skills: [...new Set(e.key_skills.map((s) => verified.get(s.trim().toLowerCase())).filter((s): s is string => !!s))],
  };
}

const REQUIRED_FALLBACK = "Готов освоить, есть смежный опыт.";

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
    // A required field the guard emptied would fail hh's form validation: an honest forward answer instead.
    if (q.required && a.text?.trim() && !clean.text) clean.text = REQUIRED_FALLBACK;
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
  const titles = new Set(existing.map((r) => r.title.trim().toLowerCase()));
  const poolIds = new Set(existing.map((r) => r.hhResumeId));
  const out: PoolVariant[] = [];
  for (const v of variants) {
    const e = cleanResumeEdit(profile, v);
    const key = e.title.toLowerCase();
    if (!key || titles.has(key)) continue;
    titles.add(key);
    out.push({
      ...e,
      based_on_resume_id: poolIds.has(v.based_on_resume_id) ? v.based_on_resume_id : (existing[0]?.hhResumeId ?? ""),
      direction: profile.directions.includes(v.direction) ? v.direction : (profile.directions[0] ?? v.direction),
    });
    if (out.length >= max) break;
  }
  return out;
}
