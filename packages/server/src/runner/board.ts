// The auto-apply job boards (hh.ru, Habr Career) share one search -> classify -> fetch -> decide -> apply loop and
// one force:<id> path. A Board supplies the site calls; hh adds its own stages (pool, viewers, touch) around
// runBoard. Career sites queue for review instead and only share the filters.
import { RunAbortError, Status, type BrowserSession, type Card, type Decision, type HHResume, type Vacancy } from "@sgz/shared";
import type { RunContext } from "./context.js";
import { classify, companyQuotaSkip, createRunCompanyTracker, ensureVacancy, filterOpts, recordSkip, skeletonVacancy, type ClassifyOpts, type RunCompanyTracker } from "./filters.js";
import { decideExtras, decideKb, readLessons } from "./learn.js";
import type { UserRun } from "./user.js";
import { errMessage, isStop, parseSalary } from "./util.js";

export interface Fetched {
  vacancy: Vacancy;
  companyKey: string;
  lockedDirection: string;
}
export interface Candidate<C extends Card = Card> extends Fetched {
  card: C;
}
export interface Approved extends Fetched {
  decision: Decision;
}

/** The site ran out of responses (Habr's allowance): the board's run stops. */
export class BoardExhausted extends Error {}

type Skip = (status: Status, detail: string) => void;

export interface Board<C extends Card = Card> {
  source: "hh" | "habr";
  maxPages: number;
  open(): Promise<BrowserSession>;
  /** One listing page; null = stop this query now, `more` false = this page was the last. */
  search(s: BrowserSession, query: string, page: number): Promise<{ cards: C[]; more: boolean } | null>;
  /** Drops a listing card before the filters (Habr: responded already, archived, external apply). */
  drop?(card: C, vacancy: Vacancy): boolean;
  /** Reads and stores the full vacancy; null = skipped (the board recorded why). `forced`: stage force:<id>. */
  fetch(s: BrowserSession, c: Candidate<C>, forced: boolean): Promise<Vacancy | null>;
  /** Sends one approved vacancy (row, log, throttle); true = it used a slot of the budget. */
  send(a: Approved, o: ClassifyOpts, skip: Skip): Promise<boolean>;
}

export function newApp(ctx: RunContext, userId: number, vacancyId: number, status: Status, detail: string) {
  return { userId, vacancyId, hhResumeId: null, generatedResumeId: null, runId: ctx.run.id, status, reasonDetail: detail, coverLetter: "", llmDecision: null, direction: "" };
}

/** search -> fetch -> decide -> apply within `budget`; returns the budget left. */
export async function runBoard<C extends Card>(ctx: RunContext, u: UserRun, b: Board<C>, plan: { search: boolean; decide: boolean; apply: boolean }, pool: HHResume[], budget: number, tracker: RunCompanyTracker): Promise<number> {
  if (!plan.search) return budget;
  if (budget <= 0) {
    ctx.log.info("search", `${b.source === "hh" ? "" : "habr: "}daily limit reached, skipping search/apply`);
    return budget;
  }
  const fetched = await fetchStage(ctx, b, await searchStage(ctx, u, b, budget, tracker), budget);
  const approved = plan.decide ? await decideStage(ctx, u, fetched, pool) : [];
  return plan.apply && approved.length ? applyStage(ctx, u, b, approved, budget, tracker) : budget;
}

async function searchStage<C extends Card>(ctx: RunContext, u: UserRun, b: Board<C>, budget: number, tracker: RunCompanyTracker): Promise<Candidate<C>[]> {
  const { user, profile, stats } = u;
  const hh = b.source === "hh";
  const s = await b.open();
  // Floors: most search hits get rejected (level, stack), so even a 1-application run needs a real pool.
  const want = Math.max(budget * 3, 15);
  const seen = new Set<string>();
  const out: Candidate<C>[] = [];
  const o = filterOpts(ctx, tracker);
  let skipped = 0;
  let sent = 0;
  if (hh) ctx.log.info("search", `searching ${profile.hh_queries.length} queries, want ${want} candidates`, { queries: profile.hh_queries });

  // Broad queries overlap: give each a fair share so one ("go") doesn't fill the whole run.
  const perQuery = Math.max(3, Math.ceil(want / Math.max(1, profile.hh_queries.length)));
  for (const query of profile.hh_queries) {
    const quota = Math.min(want, out.length + perQuery);
    for (let page = 0; page < b.maxPages && out.length < quota; page++) {
      ctx.checkAbort();
      const r = await b.search(s, query, page);
      if (!r) break;
      let fresh = 0;
      for (const card of r.cards) {
        if (seen.has(card.externalId)) continue;
        seen.add(card.externalId);
        fresh++;
        const vacancy = ensureVacancy(ctx.store, skeletonVacancy(b.source, card.externalId, card.url, card.title, card.company, parseSalary(card.salaryRaw)));
        if (b.drop?.(card, vacancy)) continue;
        // Cross-source: the dedup hash is company+title, so a job already sent on hh is skipped on Habr too.
        const c = classify(ctx.store, user, profile, vacancy, o);
        if (c.kind === "sent") {
          sent++;
          continue;
        }
        if (c.kind === "skip") {
          skipped++;
          if (c.status === Status.SKIP_DEDUP) stats.deduped();
          stats.record(c.status);
          recordSkip(ctx.store, newApp(ctx, user.id, vacancy.id, c.status, c.detail));
          continue;
        }
        out.push({ card, vacancy, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
        if (out.length >= quota) break;
      }
      stats.found(fresh);
      ctx.log.info("search", `${hh ? "" : "habr "}"${query}" page ${page}: ${r.cards.length} cards, ${fresh} new`, { query, page, ...(hh ? { cards: r.cards.length } : {}) });
      await ctx.throttle.afterRead();
      if (!r.more) break;
    }
    if (out.length >= want) break;
  }
  const done = `${out.length} candidates, ${skipped} skipped by filters/dedup`;
  ctx.log.info("search", hh ? `done: ${done}, ${sent} already sent` : `habr: ${done}`, { candidates: out.length, skipped, ...(hh ? { sent } : {}) });
  return out;
}

export async function fetchStage<C extends Card>(ctx: RunContext, b: Board<C>, candidates: Candidate<C>[], budget: number): Promise<Fetched[]> {
  const hh = b.source === "hh";
  const s = await b.open();
  const slice = candidates.slice(0, Math.max(budget * 2, 10));
  if (hh) ctx.log.info("fetch", `fetching ${slice.length} of ${candidates.length} candidates`, { fetch: slice.length });
  const out: Fetched[] = [];
  for (const c of slice) {
    ctx.checkAbort();
    const keep = (vacancy: Vacancy) => out.push({ vacancy, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
    // hh: seen with a description before (an earlier run, a restart): search still lists it, so reuse it.
    // Habr always reads the page: its response state (allowance, responded) lives there.
    if (hh && c.vacancy.descriptionText && !c.vacancy.archived && !c.vacancy.hasTest) {
      keep(c.vacancy);
      continue;
    }
    try {
      const v = await b.fetch(s, c, false);
      if (v) keep(v);
    } catch (e) {
      if (e instanceof RunAbortError || e instanceof BoardExhausted || isStop(e)) throw e;
      const w = hh ? c.card : c.vacancy;
      ctx.log.warn("fetch", `${w.title}: ${hh ? "" : "habr "}fetch failed: ${errMessage(e)}`, { url: w.url });
    }
    await ctx.throttle.afterRead();
  }
  ctx.log.info("fetch", `${hh ? "done" : "habr"}: ${out.length} to decide`, { to_decide: out.length });
  return out;
}

export async function decideStage(ctx: RunContext, u: UserRun, fetched: Fetched[], pool: HHResume[]): Promise<Approved[]> {
  const { user, profile, stats } = u;
  if (!fetched.length) {
    ctx.log.info("decide", "nothing to decide");
    return [];
  }
  if (!pool.length) throw new Error(`no hh resumes in the pool for ${user.slug}; run pool sync first`);
  await ctx.browser.close();
  await ctx.memoryGuard("decide");
  ctx.checkAbort();
  const vacancies = fetched.map((f) => f.vacancy);
  ctx.log.info("decide", `asking LLM about ${vacancies.length} vacancies with ${pool.length} resumes`);
  const decisions = await ctx.llm.decide({ profile, resumes: pool, vacancies, ...decideExtras(ctx.store, user.id, vacancies, ctx.now()) });
  stats.llmCall(Math.ceil(vacancies.length / 10));
  const byId = new Map(decisions.map((d) => [d.vacancy_id, d]));
  const approved: Approved[] = [];
  let rejected = 0;
  for (const f of fetched) {
    const v = f.vacancy;
    const d = byId.get(v.id) ?? { vacancy_id: v.id, apply: false, reason: "no decision returned", resume_id: "", cover_letter: "", direction: "", seniority: "", red_flags: [] };
    if (!d.apply) {
      rejected++;
      stats.record(Status.SKIP_LLM_REJECT);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, v.id, Status.SKIP_LLM_REJECT, d.reason), llmDecision: d });
      continue;
    }
    approved.push({ vacancy: v, decision: d, companyKey: f.companyKey, lockedDirection: f.lockedDirection });
  }
  ctx.log.info("decide", `done: ${approved.length} approved, ${rejected} rejected`, { approved: approved.length, rejected });
  return approved;
}

/** Sends within the budget and the company quota (re-checked right before each send: earlier items of this run
 * may have used it); returns the budget left. */
export async function applyStage<C extends Card>(ctx: RunContext, u: UserRun, b: Board<C>, approved: Approved[], budget: number, tracker: RunCompanyTracker): Promise<number> {
  const { user, stats } = u;
  const hh = b.source === "hh";
  if (hh) ctx.log.info("apply", `applying to up to ${Math.min(budget, approved.length)} of ${approved.length}`, { budget });
  const o = filterOpts(ctx, tracker);
  let sent = 0;
  for (const a of approved) {
    ctx.checkAbort();
    const skip: Skip = (status, detail) => {
      stats.record(status);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, a.vacancy.id, status, detail), llmDecision: a.decision });
    };
    if (budget <= 0) {
      skip(Status.SKIP_LIMIT, `${hh ? "" : "habr "}daily limit reached`);
      continue;
    }
    const full = companyQuotaSkip(ctx.store, user.id, a.companyKey, o);
    if (full) {
      skip(Status.SKIP_COMPANY_LIMIT, full);
      continue;
    }
    if (await b.send(a, o, skip)) {
      budget--;
      sent++;
    }
  }
  if (hh) ctx.log.info("apply", `done: ${sent} sent, budget left ${budget}`, { sent, budget });
  return budget;
}

/** A send that threw: FAILED_UI with the letter, logged; a stop or an exhausted board propagates. */
export async function sendFailed(ctx: RunContext, u: UserRun, tag: string, a: Approved, e: unknown, extra: { hhResumeId?: number } = {}): Promise<false> {
  if (e instanceof RunAbortError || e instanceof BoardExhausted || isStop(e)) throw e;
  const { vacancy, decision } = a;
  u.stats.record(Status.FAILED_UI, vacancy);
  ctx.store.insertApplication({ ...newApp(ctx, u.user.id, vacancy.id, Status.FAILED_UI, errMessage(e)), coverLetter: decision.cover_letter, llmDecision: decision, ...extra });
  ctx.log.error("apply", `${tag}${vacancy.title} @ ${vacancy.company}: ${errMessage(e)}`, { vacancy_id: vacancy.id });
  await ctx.throttle.afterMutation();
  return false;
}

/** Stage force:<applicationId>: the human overrode a filter / LLM reject. Fetch if needed, ask decide only for the
 * resume + letter, force apply=true and send through the normal apply path with no company quota / persona lock /
 * daily limit. */
export async function forceApply<C extends Card>(ctx: RunContext, u: UserRun, b: Board<C>, id: number, pool: HHResume[]): Promise<void> {
  const { user, profile, stats } = u;
  const hh = b.source === "hh";
  const row = ctx.store.getApplication(id);
  if (!row || row.application.userId !== user.id || row.vacancy.source !== b.source) return ctx.log.error("apply", `${b.source} application ${id} not found for ${user.slug}`);
  let vacancy: Vacancy | null = row.vacancy;
  if (ctx.store.hasSentApplication(user.id, vacancy.id)) return ctx.log.warn("apply", `${vacancy.title}: already sent`);
  if (!pool.length) throw new Error(`no hh resumes in the pool for ${user.slug}; run pool sync first`);
  if (!vacancy.descriptionText) {
    const card = { externalId: vacancy.externalId, url: vacancy.url, title: vacancy.title, company: vacancy.company, salaryRaw: "" } as C;
    vacancy = await b.fetch(await b.open(), { card, vacancy, companyKey: "", lockedDirection: "" }, true);
    if (!vacancy) return;
  }
  await ctx.browser.close();
  if (hh) await ctx.memoryGuard("decide");
  const [d] = await ctx.llm.decide({ profile, resumes: pool, vacancies: [vacancy], lessons: readLessons(ctx.store, user.id).lessons, kb: decideKb(ctx.store, user.id) });
  stats.llmCall();
  const { status, reasonDetail } = row.application;
  const was = `forced by user (was ${status}${hh && reasonDetail ? `: ${reasonDetail}` : ""})`;
  const decision: Decision = { ...(d ?? { resume_id: hh ? "" : "habr", cover_letter: "", direction: "", seniority: "", red_flags: [] }), vacancy_id: vacancy.id, apply: true, reason: `${was}${d?.reason ? `; LLM: ${d.reason}` : ""}` };
  if (hh) ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${was}`, { vacancy_id: vacancy.id, application_id: id });
  await applyStage(ctx, u, b, [{ vacancy, decision, companyKey: "", lockedDirection: "" }], 1, createRunCompanyTracker()).catch((e: unknown) => {
    if (!(e instanceof BoardExhausted)) throw e;
    ctx.log.warn("apply", e.message);
  });
}
