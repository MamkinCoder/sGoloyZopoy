// hh.ru stages for one user. Sequential; browser closed for the LLM batch (decide); abort checked
// between items so stop() takes effect quickly.
import { RunAbortError, Status, type Answer, type Card, type ChatMessage, type Decision, type HHResume, type Question, type Vacancy } from "@sgz/shared";
import { dailyBudget } from "./budget.js";
import type { RunContext } from "./context.js";
import { classify, ensureVacancy, isoDaysAgo, skeletonVacancy } from "./filters.js";
import { expandPool, syncPool, syncIsStale } from "./pool.js";
import { dayInTz } from "../scheduler/tz.js";
import type { UserRun } from "./user.js";
import { errMessage, parseSalary } from "./util.js";

export interface HHPlan {
  poolSync: "auto" | "force" | "off";
  search: boolean;
  decide: boolean;
  apply: boolean;
  chats: boolean;
  touch: boolean;
  poolExpand: boolean;
}

const MAX_PAGES_PER_QUERY = 5;

interface Candidate {
  card: Card;
  vacancy: Vacancy;
}
interface Approved {
  vacancy: Vacancy;
  decision: Decision;
}

export async function runHHUser(ctx: RunContext, u: UserRun, plan: HHPlan): Promise<void> {
  const { user, profile, stats } = u;
  const day = dayInTz(ctx.now(), ctx.cfg.tz);
  let budget = dailyBudget(ctx.store, user, ["hh"], user.dailyLimitHH, ctx.req.limit, day);
  ctx.log.info("session", `hh: user ${user.slug}, budget ${budget}, dry_run=${ctx.req.dryRun}`, { budget, day });

  let pool = ctx.store.listHHResumes(user.id);
  const stale = syncIsStale(ctx, user);
  if (plan.poolSync === "force" || (plan.poolSync === "auto" && (pool.length === 0 || stale))) {
    pool = await syncPool(ctx, u);
  }

  let approved: Approved[] = [];
  if (plan.search) {
    if (budget <= 0) {
      ctx.log.info("search", "daily limit reached, skipping search/apply");
    } else {
      const candidates = await searchStage(ctx, u, budget);
      const fetched = await fetchStage(ctx, u, candidates, budget);
      if (plan.decide) approved = await decideStage(ctx, u, fetched, pool);
    }
  }
  if (plan.apply && approved.length) budget = await applyStage(ctx, u, approved, pool, budget);
  if (plan.chats) await chatsStage(ctx, u);
  if (plan.touch) await touchStage(ctx, u, pool.length ? pool : ctx.store.listHHResumes(user.id));
  if (plan.poolExpand) await expandPool(ctx, u, pool.length ? pool : ctx.store.listHHResumes(user.id));
  void stats;
}

async function searchStage(ctx: RunContext, u: UserRun, budget: number): Promise<Candidate[]> {
  const { user, profile, stats } = u;
  const s = await ctx.browser.openHH(user);
  const want = budget * 3;
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const dedupSince = isoDaysAgo(ctx.now(), dedupWindowDays(ctx, 30));
  let skipped = 0;
  let sent = 0;
  ctx.log.info("search", `searching ${profile.hh_queries.length} queries, want ${want} candidates`, { queries: profile.hh_queries });

  for (const query of profile.hh_queries) {
    for (let page = 0; page < MAX_PAGES_PER_QUERY && candidates.length < want; page++) {
      ctx.checkAbort();
      const cards = await ctx.hh.search(s, { query, page, period: 1, area: profile.hh_area || undefined, excludeWords: profile.exclude_words });
      if (!cards.length) break;
      let fresh = 0;
      for (const card of cards) {
        if (seen.has(card.externalId)) continue;
        seen.add(card.externalId);
        fresh++;
        const vacancy = ensureVacancy(ctx.store, skeletonVacancy("hh", card.externalId, card.url, card.title, card.company, parseSalary(card.salaryRaw)));
        const c = classify(ctx.store, user, profile, vacancy, dedupSince);
        if (c.kind === "sent") {
          sent++;
          continue;
        }
        if (c.kind === "skip") {
          skipped++;
          if (c.status === Status.SKIP_DEDUP) stats.deduped();
          stats.record(c.status);
          ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, c.status, c.detail));
          continue;
        }
        candidates.push({ card, vacancy });
        if (candidates.length >= want) break;
      }
      stats.found(fresh);
      ctx.log.info("search", `"${query}" page ${page}: ${cards.length} cards, ${fresh} new`, { query, page, cards: cards.length });
      await ctx.throttle.afterRead();
    }
    if (candidates.length >= want) break;
  }
  ctx.log.info("search", `done: ${candidates.length} candidates, ${skipped} skipped by filters/dedup, ${sent} already sent`, { candidates: candidates.length, skipped, sent });
  return candidates;
}

async function fetchStage(ctx: RunContext, u: UserRun, candidates: Candidate[], budget: number): Promise<Vacancy[]> {
  const { user, stats } = u;
  const s = await ctx.browser.openHH(user);
  const slice = candidates.slice(0, budget * 2);
  ctx.log.info("fetch", `fetching ${slice.length} of ${candidates.length} candidates`, { fetch: slice.length });
  const out: Vacancy[] = [];
  for (const c of slice) {
    ctx.checkAbort();
    try {
      const r = await ctx.hh.fetchVacancy(s, c.card);
      const v = ctx.store.upsertVacancy({ ...r.vacancy, id: c.vacancy.id });
      let skip: Status | null = null;
      if (r.alreadyApplied) skip = Status.SKIP_ALREADY_APPLIED;
      else if (v.archived) skip = Status.SKIP_ARCHIVED;
      else if (v.hasTest) skip = Status.SKIP_TEST_REQUIRED;
      if (skip) {
        stats.record(skip);
        ctx.store.insertApplication(newApp(ctx, user.id, v.id, skip, ""));
        ctx.log.info("fetch", `${v.title} @ ${v.company}: ${skip}`);
      } else out.push(v);
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.warn("fetch", `${c.card.title}: fetch failed: ${errMessage(e)}`, { url: c.card.url });
    }
    await ctx.throttle.afterRead();
  }
  ctx.log.info("fetch", `done: ${out.length} to decide`, { to_decide: out.length });
  return out;
}

async function decideStage(ctx: RunContext, u: UserRun, vacancies: Vacancy[], pool: HHResume[]): Promise<Approved[]> {
  const { user, profile, stats } = u;
  if (!vacancies.length) {
    ctx.log.info("decide", "nothing to decide");
    return [];
  }
  if (!pool.length) throw new Error(`no hh resumes in the pool for ${user.slug}; run pool sync first`);
  await ctx.browser.close();
  await ctx.memoryGuard("decide");
  ctx.checkAbort();
  ctx.log.info("decide", `asking LLM about ${vacancies.length} vacancies with ${pool.length} resumes`);
  const decisions = await ctx.llm.decide({ profile, resumes: pool, vacancies });
  stats.llmCall(Math.ceil(vacancies.length / 10));
  const byId = new Map(decisions.map((d) => [d.vacancy_id, d]));
  const approved: Approved[] = [];
  let rejected = 0;
  for (const v of vacancies) {
    const d = byId.get(v.id) ?? { vacancy_id: v.id, apply: false, reason: "no decision returned", resume_id: "", cover_letter: "", direction: "", seniority: "", red_flags: [] };
    if (!d.apply) {
      rejected++;
      stats.record(Status.SKIP_LLM_REJECT);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, v.id, Status.SKIP_LLM_REJECT, d.reason), llmDecision: d });
      continue;
    }
    approved.push({ vacancy: v, decision: d });
  }
  ctx.log.info("decide", `done: ${approved.length} approved, ${rejected} rejected`, { approved: approved.length, rejected });
  return approved;
}

async function applyStage(ctx: RunContext, u: UserRun, approved: Approved[], pool: HHResume[], budget: number): Promise<number> {
  const { user, profile, stats } = u;
  ctx.log.info("apply", `applying to up to ${Math.min(budget, approved.length)} of ${approved.length}`, { budget });
  let sentNow = 0;
  for (const { vacancy, decision } of approved) {
    ctx.checkAbort();
    if (budget <= 0) {
      stats.record(Status.SKIP_LIMIT);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, Status.SKIP_LIMIT, "daily limit reached"), llmDecision: decision });
      continue;
    }
    const s = await ctx.browser.openHH(user);
    const resume = pool.find((r) => r.hhResumeId === decision.resume_id) ?? pool[0];
    if (!resume) throw new Error("empty resume pool at apply stage");
    let questions: Question[] | undefined;
    let answers: Answer[] | undefined;
    try {
      const r = await ctx.hh.apply(s, {
        vacancy,
        resumeTitle: resume.title,
        coverLetter: decision.cover_letter,
        allowOtherCountry: user.allowOtherCountry,
        dryRun: ctx.req.dryRun,
        answerQuestions: async (qs) => {
          questions = qs;
          answers = await ctx.llm.answerQuestionnaire(profile, vacancy, qs);
          stats.llmCall();
          return answers;
        },
      });
      const status = ctx.req.dryRun && r.status === Status.SENT ? Status.SKIP_DRY_RUN : r.status;
      const app = ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, status, r.reasonDetail), coverLetter: decision.cover_letter, llmDecision: decision, hhResumeId: resume.id });
      const qs = r.questions ?? questions;
      const as = r.answers ?? answers;
      if (qs?.length && as?.length) ctx.store.insertQuestionnaireAnswers(app.id, qs, as);
      stats.record(status, vacancy);
      if (status === Status.SENT) {
        budget--;
        sentNow++;
      }
      ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${status}${r.reasonDetail ? ` (${r.reasonDetail})` : ""}`, { vacancy_id: vacancy.id, status, resume: resume.title });
      if (r.status === Status.SENT || r.status === Status.SKIP_DRY_RUN || r.status.startsWith("FAILED_")) await ctx.throttle.afterMutation();
      else await ctx.throttle.afterRead();
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      stats.record(Status.FAILED_UI, vacancy);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, Status.FAILED_UI, errMessage(e)), coverLetter: decision.cover_letter, llmDecision: decision, hhResumeId: resume.id });
      ctx.log.error("apply", `${vacancy.title} @ ${vacancy.company}: ${errMessage(e)}`, { vacancy_id: vacancy.id });
      await ctx.throttle.afterMutation();
    }
  }
  ctx.log.info("apply", `done: ${sentNow} sent, budget left ${budget}`, { sent: sentNow, budget });
  return budget;
}

async function chatsStage(ctx: RunContext, u: UserRun): Promise<void> {
  const { user, profile, stats } = u;
  const s = await ctx.browser.openHH(user);
  const known = new Map(ctx.store.listChatThreads(user.id).map((t) => [t.hhNegotiationId, t]));
  const threads = await ctx.hh.listThreads(s, true);
  ctx.log.info("chats", `${threads.length} unread threads`, { threads: threads.length });
  let replies = 0;
  for (const t of threads) {
    ctx.checkAbort();
    try {
      const detail = await ctx.hh.readThread(s, t.chatUrl);
      const prev = known.get(t.negotiationId);
      const ext = detail.vacancyExternalId ?? t.vacancyExternalId;
      const vacancy = ext ? ctx.store.findVacancyByExternal("hh", ext) : null;
      const thread = ctx.store.upsertChatThread({
        ...detail.thread,
        id: prev?.id,
        userId: user.id,
        hhNegotiationId: t.negotiationId,
        vacancyId: vacancy?.id ?? prev?.vacancyId ?? null,
        state: prev?.state === "needs_human" ? "needs_human" : detail.thread.state,
        lastSeenAt: ctx.now().toISOString(),
      });
      const inserted = ctx.store.insertChatMessages(thread.id, detail.messages);
      if (detail.thread.state === "invited" && prev?.state !== "invited") stats.invitation();
      if (detail.thread.state === "rejected" && prev?.state !== "rejected") stats.rejection();

      if (detail.survey.length) {
        const answers = await ctx.llm.answerQuestionnaire(profile, vacancy, detail.survey);
        stats.llmCall();
        if (!ctx.req.dryRun) await ctx.hh.submitSurvey(s, t.chatUrl, answers);
        // A dry run must leave the thread eligible for a real run. The generated
        // answers are reported in the run log, but no local message is marked done.
        if (!ctx.req.dryRun) ctx.store.markAnswered(unansweredQuestionIds(ctx.store.listChatMessages(thread.id)));
        stats.chatReply();
        replies++;
        ctx.log.info("chats", `${t.employer}: survey answered (${detail.survey.length} questions)${ctx.req.dryRun ? " [dry-run]" : ""}`, { thread_id: thread.id });
        await ctx.throttle.afterMutation();
        continue;
      }

      const history = ctx.store.listChatMessages(thread.id);
      const last = [...history].reverse().find((m) => m.direction === "in");
      if (!last || !last.isQuestion || last.answered) {
        await ctx.throttle.afterRead();
        continue;
      }
      if (prev?.state === "needs_human" && inserted === 0) {
        ctx.log.info("chats", `${t.employer}: still waiting for a human`, { thread_id: thread.id });
        continue;
      }
      const reply = await ctx.llm.answerChat(profile, vacancy, history);
      stats.llmCall();
      if (reply.needs_human || !reply.reply.trim()) {
        ctx.store.upsertChatThread({ ...thread, state: "needs_human" });
        ctx.log.warn("chats", `${t.employer}: needs human (${reply.reason})`, { thread_id: thread.id });
        await ctx.deps.notifier.alert(`Чат требует ответа: ${t.employer}`, `${user.name}: ${last.text}\n\n${reply.reason}\n${t.chatUrl}`);
        continue;
      }
      if (!ctx.req.dryRun) await ctx.hh.sendMessage(s, t.chatUrl, reply.reply);
      if (!ctx.req.dryRun) {
        ctx.store.insertChatMessages(thread.id, [{ hhMessageId: null, direction: "out", author: "me", text: reply.reply, isQuestion: false, answered: true }]);
        ctx.store.markAnswered(unansweredQuestionIds(history));
      }
      stats.chatReply();
      replies++;
      ctx.log.info("chats", `${t.employer}: replied${ctx.req.dryRun ? " [dry-run]" : ""}`, { thread_id: thread.id });
      await ctx.throttle.afterMutation();
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.error("chats", `${t.employer}: ${errMessage(e)}`, { negotiation: t.negotiationId });
    }
  }
  ctx.log.info("chats", `done: ${replies} replies`, { replies });
}

async function touchStage(ctx: RunContext, u: UserRun, pool: HHResume[]): Promise<void> {
  if (!pool.length) return;
  if (ctx.req.dryRun) {
    ctx.log.info("touch", `[dry-run] would touch ${pool.length} resumes`, { resumes: pool.length });
    return;
  }
  const s = await ctx.browser.openHH(u.user);
  let ok = 0;
  for (const r of pool) {
    ctx.checkAbort();
    try {
      await ctx.hh.touchResume(s, r.url);
      ok++;
    } catch (e) {
      ctx.log.warn("touch", `${r.title}: ${errMessage(e)}`);
    }
    await ctx.throttle.afterRead();
  }
  ctx.log.info("touch", `done: ${ok}/${pool.length} resumes touched`, { touched: ok });
}

const unansweredQuestionIds = (msgs: ChatMessage[]): number[] => msgs.filter((m) => m.direction === "in" && m.isQuestion && !m.answered).map((m) => m.id);

function dedupWindowDays(ctx: RunContext, fallback: number): number {
  const n = Number(ctx.store.getSetting("dedup_window_days"));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function newApp(ctx: RunContext, userId: number, vacancyId: number, status: Status, detail: string) {
  return { userId, vacancyId, hhResumeId: null, generatedResumeId: null, runId: ctx.run.id, status, reasonDetail: detail, coverLetter: "", llmDecision: null };
}

export const isStop = (e: unknown): boolean => e instanceof Error && e.name === "RunStoppedError";
