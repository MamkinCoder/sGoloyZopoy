// Habr Career stages for one user: search (logged-in listing) → filters → fetch → decide (the hh decide
// with a one-resume pool: Habr allows one profile) → apply with a cover letter, no review queue. Same browser
// and Chrome profile as hh, Habr cookies injected. Habr conversations: the always-on agent (src/agent/chats).
import { RunAbortError, Status, type Decision, type HHResume, type User, type Vacancy } from "@sgz/shared";
import { MIN_RESPONSES_LEFT, type HabrClient } from "../habr/client.js";
import { dayInTz } from "../scheduler/tz.js";
import { dailyBudget } from "./budget.js";
import type { RunContext } from "./context.js";
import { classify, companyLimitSettings, createRunCompanyTracker, dedupWindowDays, ensureVacancy, isoDaysAgo, recordSkip, rejectWindowDays, skeletonVacancy, type RunCompanyTracker } from "./filters.js";
import { decideStage, newApp } from "./hh.js";
import { decideKb, readLessons } from "./learn.js";
import type { UserRun } from "./user.js";
import { errMessage, isStop, parseSalary } from "./util.js";

export interface HabrPlan {
  search: boolean;
  decide: boolean;
  apply: boolean;
  /** Stage force:<applicationId>: apply to that one filtered-out Habr vacancy. */
  force: number | null;
}

const MAX_PAGES_PER_QUERY = 3;
export const HABR_DAILY_LIMIT_DEFAULT = 20;

/** Setting `habr_daily_limit` (applications per day), default 20. */
export function habrDailyLimit(ctx: Pick<RunContext, "store">): number {
  const raw = ctx.store.getSetting("habr_daily_limit");
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : HABR_DAILY_LIMIT_DEFAULT;
}

/** The single Habr profile as a decide pool of one: resume_id "habr", direction fullstack, the profile's stack. */
export function habrPool(user: User, profile: UserRun["profile"]): HHResume[] {
  return [
    {
      id: 0,
      userId: user.id,
      hhResumeId: "habr",
      title: "Профиль на Хабр Карьере (универсальный: backend, frontend, fullstack, AI, DevOps)",
      url: "https://career.habr.com/",
      direction: "fullstack",
      summary: { direction: "fullstack", seniority: "middle", key_skills: profile.verified_skills.slice(0, 20), one_line: profile.summary.slice(0, 200) },
      isGenerated: false,
      syncedAt: "",
    },
  ];
}

interface Fetched {
  vacancy: Vacancy;
  companyKey: string;
  lockedDirection: string;
}

class ResponsesExhausted extends Error {}

export async function runHabrUser(ctx: RunContext, u: UserRun, plan: HabrPlan): Promise<void> {
  const habr = ctx.deps.habr;
  if (!habr) return ctx.log.warn("session", "habr: client not configured, skipping");
  const { user } = u;
  const pool = habrPool(user, u.profile);
  if (plan.force !== null) return forceApply(ctx, u, habr, plan.force, pool);
  let budget = dailyBudget(ctx.store, user, ["habr"], habrDailyLimit(ctx), ctx.req.limit, ctx.now(), ctx.cfg.tz);
  ctx.log.info("session", `habr: user ${user.slug}, budget ${budget}, dry_run=${ctx.req.dryRun}`, { budget, day: dayInTz(ctx.now(), ctx.cfg.tz) });
  const tracker = createRunCompanyTracker();
  try {
    if (plan.search) {
      if (budget <= 0) ctx.log.info("search", "habr: daily limit reached, skipping search/apply");
      else {
        const fetched = await fetchStage(ctx, u, habr, await searchStage(ctx, u, habr, budget, tracker), budget);
        const approved = plan.decide ? await decideStage(ctx, u, fetched, pool) : [];
        if (plan.apply && approved.length) budget = await applyStage(ctx, u, habr, approved, budget, tracker);
      }
    }
  } catch (e) {
    if (!(e instanceof ResponsesExhausted)) throw e;
    ctx.log.warn("apply", e.message);
    if (!ctx.req.dryRun) await ctx.deps.notifier.alert("Хабр Карьера: отклики заканчиваются", `${user.name}: ${e.message}. Автоотклики на Хабре остановлены до пополнения лимита.`).catch(() => undefined);
  }
}

async function searchStage(ctx: RunContext, u: UserRun, habr: HabrClient, budget: number, tracker: RunCompanyTracker): Promise<{ vacancy: Vacancy; companyKey: string; lockedDirection: string }[]> {
  const { user, profile, stats } = u;
  const s = await ctx.browser.openHabr(user);
  const want = Math.max(budget * 3, 15);
  const perQuery = Math.max(3, Math.ceil(want / Math.max(1, profile.hh_queries.length)));
  const opts = {
    dedupSinceISO: isoDaysAgo(ctx.now(), dedupWindowDays(ctx.store, 30)),
    rejectSinceISO: isoDaysAgo(ctx.now(), rejectWindowDays(ctx.store, 30)),
    company: companyLimitSettings(ctx.store),
    companySinceISO: "",
    runTracker: tracker,
  };
  opts.companySinceISO = isoDaysAgo(ctx.now(), opts.company.windowDays);
  const seen = new Set<string>();
  const out: { vacancy: Vacancy; companyKey: string; lockedDirection: string }[] = [];
  let skipped = 0;
  // hh_queries are IT searches already; Habr Career is an IT-only board, so no role filter is needed.
  for (const query of profile.hh_queries) {
    const quota = Math.min(want, out.length + perQuery);
    for (let page = 0; page < MAX_PAGES_PER_QUERY && out.length < quota; page++) {
      ctx.checkAbort();
      const { cards, totalPages } = await habr.search(s, query, page);
      let fresh = 0;
      for (const card of cards) {
        if (seen.has(card.externalId)) continue;
        seen.add(card.externalId);
        fresh++;
        const vacancy = ensureVacancy(ctx.store, skeletonVacancy("habr", card.externalId, card.url, card.title, card.company, parseSalary(card.salaryRaw)));
        if (card.alreadyApplied) {
          if (!ctx.store.hasSentApplication(user.id, vacancy.id)) recordSkip(ctx.store, newApp(ctx, user.id, vacancy.id, Status.SKIP_ALREADY_APPLIED, "Habr listing: already responded"));
          continue;
        }
        // Archived and external-apply stay that way: don't re-fetch them every run (they would crowd out new ones).
        const last = ctx.store.lastApplication(user.id, vacancy.id);
        if (last && (last.status === Status.SKIP_ARCHIVED || (last.status === Status.SKIP_FILTER && last.reasonDetail.startsWith("response kind")))) continue;
        // Cross-source: the dedup hash is company+title, so a job already sent on hh (or queued on a site) is skipped here.
        const c = classify(ctx.store, user, profile, vacancy, opts);
        if (c.kind === "sent") continue;
        if (c.kind === "skip") {
          skipped++;
          if (c.status === Status.SKIP_DEDUP) stats.deduped();
          stats.record(c.status);
          recordSkip(ctx.store, newApp(ctx, user.id, vacancy.id, c.status, c.detail));
          continue;
        }
        out.push({ vacancy, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
        if (out.length >= quota) break;
      }
      stats.found(fresh);
      ctx.log.info("search", `habr "${query}" page ${page}: ${cards.length} cards, ${fresh} new`, { query, page });
      await ctx.throttle.afterRead();
      if (page + 1 >= totalPages) break;
    }
    if (out.length >= want) break;
  }
  ctx.log.info("search", `habr: ${out.length} candidates, ${skipped} skipped by filters/dedup`, { candidates: out.length, skipped });
  return out;
}

async function fetchStage(ctx: RunContext, u: UserRun, habr: HabrClient, candidates: Fetched[], budget: number): Promise<Fetched[]> {
  const { user, stats } = u;
  const s = await ctx.browser.openHabr(user);
  const out: Fetched[] = [];
  for (const c of candidates.slice(0, Math.max(budget * 2, 10))) {
    ctx.checkAbort();
    try {
      const r = await habr.fetchVacancy(s, c.vacancy);
      const v = ctx.store.upsertVacancy({ ...r.vacancy, id: c.vacancy.id });
      const st = r.state;
      if (st.responsesLeft !== null && st.responsesLeft < MIN_RESPONSES_LEFT) throw new ResponsesExhausted(`only ${st.responsesLeft} Habr responses left`);
      const skip: [Status, string] | null =
        st.responded || st.kind === "applied" ? [Status.SKIP_ALREADY_APPLIED, "Habr shows our response"]
        : v.archived ? [Status.SKIP_ARCHIVED, ""]
        : st.placeholder ? [Status.SKIP_FILTER, `no response form: ${st.placeholder}`]
        : st.kind !== "direct" ? [Status.SKIP_FILTER, `response kind «${st.kind || "none"}»: external apply`]
        : null;
      if (skip) {
        stats.record(skip[0]);
        recordSkip(ctx.store, newApp(ctx, user.id, v.id, skip[0], skip[1]));
        ctx.log.info("fetch", `${v.title} @ ${v.company}: ${skip[0]}${skip[1] ? ` (${skip[1]})` : ""}`);
      } else out.push({ ...c, vacancy: v });
    } catch (e) {
      if (e instanceof RunAbortError || e instanceof ResponsesExhausted || isStop(e)) throw e;
      ctx.log.warn("fetch", `${c.vacancy.title}: habr fetch failed: ${errMessage(e)}`, { url: c.vacancy.url });
    }
    await ctx.throttle.afterRead();
  }
  ctx.log.info("fetch", `habr: ${out.length} to decide`, { to_decide: out.length });
  return out;
}

async function applyStage(ctx: RunContext, u: UserRun, habr: HabrClient, approved: { vacancy: Vacancy; decision: Decision; companyKey: string }[], budget: number, tracker: RunCompanyTracker): Promise<number> {
  const { user, stats } = u;
  const company = companyLimitSettings(ctx.store);
  const companySince = isoDaysAgo(ctx.now(), company.windowDays);
  for (const { vacancy, decision, companyKey } of approved) {
    ctx.checkAbort();
    const skip = (status: Status, detail: string) => {
      stats.record(status);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, status, detail), llmDecision: decision });
    };
    if (budget <= 0) {
      skip(Status.SKIP_LIMIT, "habr daily limit reached");
      continue;
    }
    if (companyKey && company.maxSent > 0) {
      const total = ctx.store.countRecentApplicationsByCompany(user.id, companyKey, companySince) + tracker.count(companyKey);
      if (total >= company.maxSent) {
        skip(Status.SKIP_COMPANY_LIMIT, `company limit reached: ${total}/${company.maxSent} sent in ${company.windowDays}d`);
        continue;
      }
    }
    const s = await ctx.browser.openHabr(user);
    try {
      const r = await habr.apply(s, { vacancy, coverLetter: decision.cover_letter, dryRun: ctx.req.dryRun });
      // A SENT row carries the letter only when Habr saved it: the panel and the lessons read it as delivered.
      const coverLetter = r.status === Status.SENT && r.reasonDetail !== "sent with letter" ? "" : decision.cover_letter;
      ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, r.status, r.reasonDetail), coverLetter, llmDecision: decision, direction: decision.direction });
      stats.record(r.status, vacancy);
      if ((r.status === Status.SENT || r.status === Status.SKIP_DRY_RUN) && companyKey) tracker.reserve(companyKey, decision.direction);
      if (r.status === Status.SENT) budget--;
      ctx.log.info("apply", `habr ${vacancy.title} @ ${vacancy.company}: ${r.status}${r.reasonDetail ? ` (${r.reasonDetail})` : ""}`, { vacancy_id: vacancy.id, status: r.status, responses_left: r.responsesLeft });
      if (r.status === Status.SENT || r.status.startsWith("FAILED_")) await ctx.throttle.afterMutation();
      else await ctx.throttle.afterRead();
      if (r.responsesLeft !== null && r.responsesLeft < MIN_RESPONSES_LEFT) throw new ResponsesExhausted(`only ${r.responsesLeft} Habr responses left`);
    } catch (e) {
      if (e instanceof RunAbortError || e instanceof ResponsesExhausted || isStop(e)) throw e;
      stats.record(Status.FAILED_UI, vacancy);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, Status.FAILED_UI, errMessage(e)), coverLetter: decision.cover_letter, llmDecision: decision });
      ctx.log.error("apply", `habr ${vacancy.title} @ ${vacancy.company}: ${errMessage(e)}`, { vacancy_id: vacancy.id });
      await ctx.throttle.afterMutation();
    }
  }
  return budget;
}

/** The human overrode a filter in the panel: fetch if needed, decide for the letter only, apply regardless. */
async function forceApply(ctx: RunContext, u: UserRun, habr: HabrClient, id: number, pool: HHResume[]): Promise<void> {
  const { user, profile } = u;
  const row = ctx.store.getApplication(id);
  if (!row || row.application.userId !== user.id || row.vacancy.source !== "habr") return ctx.log.error("apply", `habr application ${id} not found for ${user.slug}`);
  let vacancy = row.vacancy;
  if (ctx.store.hasSentApplication(user.id, vacancy.id)) return ctx.log.warn("apply", `${vacancy.title}: already sent`);
  if (!vacancy.descriptionText) {
    const r = await habr.fetchVacancy(await ctx.browser.openHabr(user), vacancy);
    vacancy = ctx.store.upsertVacancy({ ...r.vacancy, id: vacancy.id });
  }
  await ctx.browser.close();
  const [d] = await ctx.llm.decide({ profile, resumes: pool, vacancies: [vacancy], lessons: readLessons(ctx.store, user.id).lessons, kb: decideKb(ctx.store, user.id) });
  u.stats.llmCall();
  const decision: Decision = { ...(d ?? { resume_id: "habr", cover_letter: "", direction: "", seniority: "", red_flags: [] }), vacancy_id: vacancy.id, apply: true, reason: `forced by user (was ${row.application.status})${d?.reason ? `; LLM: ${d.reason}` : ""}` };
  await applyStage(ctx, u, habr, [{ vacancy, decision, companyKey: "" }], 1, createRunCompanyTracker()).catch((e: unknown) => {
    if (!(e instanceof ResponsesExhausted)) throw e;
    ctx.log.warn("apply", e.message);
  });
}
