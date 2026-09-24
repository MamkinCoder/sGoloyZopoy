// hh.ru stages for one user. Sequential; browser closed for the LLM batch (decide); abort checked
// between items so stop() takes effect quickly.
import { RunAbortError, Status, type Answer, type Card, type BrowserSession, type Decision, type HHResume, type Question, type Vacancy } from "@sgz/shared";
import { dailyBudget } from "./budget.js";
import type { RunContext } from "./context.js";
import { classify, companyLimitSettings, createRunCompanyTracker, dedupWindowDays, ensureVacancy, isoDaysAgo, recordSkip, rejectWindowDays, skeletonVacancy, type RunCompanyTracker } from "./filters.js";
import { expandPool, syncPool, syncIsStale } from "./pool.js";
import { decideExtras, decideKb, readLessons } from "./learn.js";
import { kbForVacancy } from "../kb/context.js";
import { renderQuestions } from "../llm/format.js";
import { viewersStage } from "./viewers.js";
import { dayInTz } from "../scheduler/tz.js";
import type { UserRun } from "./user.js";
import { errMessage, isStop, parseSalary } from "./util.js";

export interface HHPlan {
  poolSync: "auto" | "force" | "off";
  search: boolean;
  decide: boolean;
  apply: boolean;
  touch: boolean;
  poolExpand: boolean;
  /** Stage force:<applicationId>: apply to that one filtered-out vacancy, ignoring filters and the LLM reject. */
  force: number | null;
}

const MAX_PAGES_PER_QUERY = 5;

export interface Candidate {
  card: Card;
  vacancy: Vacancy;
  companyKey: string;
  lockedDirection: string;
}
interface Approved {
  vacancy: Vacancy;
  decision: Decision;
  companyKey: string;
  lockedDirection: string;
}

export async function runHHUser(ctx: RunContext, u: UserRun, plan: HHPlan): Promise<void> {
  const { user } = u;
  const day = dayInTz(ctx.now(), ctx.cfg.tz);
  let budget = dailyBudget(ctx.store, user, ["hh"], user.dailyLimitHH, ctx.req.limit, ctx.now(), ctx.cfg.tz);
  ctx.log.info("session", `hh: user ${user.slug}, budget ${budget}, dry_run=${ctx.req.dryRun}`, { budget, day });

  let pool = ctx.store.listHHResumes(user.id);
  const stale = syncIsStale(ctx, user);
  if (plan.poolSync === "force" || (plan.poolSync === "auto" && (pool.length === 0 || stale))) {
    pool = await syncPool(ctx, u);
  }

  // Shared across search/decide/apply so one run never sends past the company quota, even split
  // across several search pages or dry-run "would-be" sends.
  const companyTracker = createRunCompanyTracker();
  if (plan.force !== null) return forceApply(ctx, u, plan.force, pool);

  // Warm leads first: employers who opened a resume get the budget before cold search does.
  if (plan.apply && budget > 0) budget = await viewersStage(ctx, u, pool, budget, companyTracker);

  let approved: Approved[] = [];
  if (plan.search) {
    if (budget <= 0) {
      ctx.log.info("search", "daily limit reached, skipping search/apply");
    } else {
      const candidates = await searchStage(ctx, u, budget, companyTracker);
      const fetched = await fetchStage(ctx, u, candidates, budget);
      if (plan.decide) approved = await decideStage(ctx, u, fetched, pool);
    }
  }
  if (plan.apply && approved.length) budget = await applyStage(ctx, u, approved, pool, budget, companyTracker);
  if (plan.touch) await touchStage(ctx, u, pool.length ? pool : ctx.store.listHHResumes(user.id));
  if (plan.poolExpand) await expandPool(ctx, u, pool.length ? pool : ctx.store.listHHResumes(user.id));
}

async function searchStage(ctx: RunContext, u: UserRun, budget: number, companyTracker: RunCompanyTracker): Promise<Candidate[]> {
  const { user, profile, stats } = u;
  const s = await ctx.browser.openHH(user);
  // Floors: most search hits get rejected (level, stack), so even a 1-application run needs a real pool.
  const want = Math.max(budget * 3, 15);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const dedupSince = isoDaysAgo(ctx.now(), dedupWindowDays(ctx.store, 30));
  const rejectSince = isoDaysAgo(ctx.now(), rejectWindowDays(ctx.store, 30));
  const company = companyLimitSettings(ctx.store);
  const companySince = isoDaysAgo(ctx.now(), company.windowDays);
  let skipped = 0;
  let sent = 0;
  ctx.log.info("search", `searching ${profile.hh_queries.length} queries, want ${want} candidates`, { queries: profile.hh_queries });

  // Broad queries overlap: give each a fair share so one ("go") doesn't fill the whole run.
  const perQuery = Math.max(3, Math.ceil(want / Math.max(1, profile.hh_queries.length)));
  for (const query of profile.hh_queries) {
    const quota = Math.min(want, candidates.length + perQuery);
    for (let page = 0; page < MAX_PAGES_PER_QUERY && candidates.length < quota; page++) {
      ctx.checkAbort();
      const cards = await ctx.hh.search(s, { query, page, period: 1, area: profile.hh_area || undefined, roles: IT_ROLES });
      if (!cards.length) break;
      let fresh = 0;
      for (const card of cards) {
        if (seen.has(card.externalId)) continue;
        seen.add(card.externalId);
        fresh++;
        const vacancy = ensureVacancy(ctx.store, skeletonVacancy("hh", card.externalId, card.url, card.title, card.company, parseSalary(card.salaryRaw)));
        const c = classify(ctx.store, user, profile, vacancy, { dedupSinceISO: dedupSince, rejectSinceISO: rejectSince, company, companySinceISO: companySince, runTracker: companyTracker });
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
        candidates.push({ card, vacancy, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
        if (candidates.length >= quota) break;
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

interface Fetched {
  vacancy: Vacancy;
  companyKey: string;
  lockedDirection: string;
}

export async function fetchStage(ctx: RunContext, u: UserRun, candidates: Candidate[], budget: number): Promise<Fetched[]> {
  const { user, stats } = u;
  const s = await ctx.browser.openHH(user);
  const slice = candidates.slice(0, Math.max(budget * 2, 10));
  ctx.log.info("fetch", `fetching ${slice.length} of ${candidates.length} candidates`, { fetch: slice.length });
  const out: Fetched[] = [];
  for (const c of slice) {
    ctx.checkAbort();
    // Seen with a description before (an earlier run, a restart): search still lists it, so reuse it.
    if (c.vacancy.descriptionText && !c.vacancy.archived && !c.vacancy.hasTest) {
      out.push({ vacancy: c.vacancy, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
      continue;
    }
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
      } else out.push({ vacancy: v, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.warn("fetch", `${c.card.title}: fetch failed: ${errMessage(e)}`, { url: c.card.url });
    }
    await ctx.throttle.afterRead();
  }
  ctx.log.info("fetch", `done: ${out.length} to decide`, { to_decide: out.length });
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

export async function applyStage(ctx: RunContext, u: UserRun, approved: Approved[], pool: HHResume[], budget: number, companyTracker: RunCompanyTracker): Promise<number> {
  const { user, profile, stats } = u;
  ctx.log.info("apply", `applying to up to ${Math.min(budget, approved.length)} of ${approved.length}`, { budget });
  const company = companyLimitSettings(ctx.store);
  const companySince = isoDaysAgo(ctx.now(), company.windowDays);
  let sentNow = 0;
  for (const { vacancy, decision, companyKey, lockedDirection } of approved) {
    ctx.checkAbort();
    if (budget <= 0) {
      stats.record(Status.SKIP_LIMIT);
      ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, Status.SKIP_LIMIT, "daily limit reached"), llmDecision: decision });
      continue;
    }
    // Re-check right before sending: other candidates approved earlier in this same run may have
    // already used up the company's quota, or locked it to a different CV direction.
    if (companyKey && company.maxSent > 0) {
      const total = ctx.store.countRecentApplicationsByCompany(user.id, companyKey, companySince) + companyTracker.count(companyKey);
      if (total >= company.maxSent) {
        stats.record(Status.SKIP_COMPANY_LIMIT);
        ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, Status.SKIP_COMPANY_LIMIT, `company limit reached: ${total}/${company.maxSent} sent in ${company.windowDays}d`), llmDecision: decision });
        continue;
      }
    }
    let resume = pool.find((r) => r.hhResumeId === decision.resume_id) ?? pool[0];
    if (!resume) throw new Error("empty resume pool at apply stage");
    const effectiveLock = lockedDirection || companyTracker.lockedDirection(companyKey);
    if (company.personaLockEnabled && effectiveLock && resume.direction !== effectiveLock) {
      const matching = pool.find((r) => r.direction === effectiveLock);
      if (matching) resume = matching;
      else {
        stats.record(Status.SKIP_COMPANY_PERSONA);
        ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, Status.SKIP_COMPANY_PERSONA, `company locked to direction "${effectiveLock}", no matching resume in pool`), llmDecision: decision });
        continue;
      }
    }
    const s = await ctx.browser.openHH(user);
    resume = await tailorResume(ctx, u, s, decision, resume, pool, company.personaLockEnabled ? effectiveLock : "");
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
          answers = await ctx.llm.answerQuestionnaire(profile, vacancy, qs, kbForVacancy(ctx.store, user.id, vacancy, renderQuestions(qs)));
          stats.llmCall();
          return answers;
        },
      });
      const status = ctx.req.dryRun && r.status === Status.SENT ? Status.SKIP_DRY_RUN : r.status;
      const app = ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, status, r.reasonDetail), coverLetter: decision.cover_letter, llmDecision: decision, hhResumeId: resume.id, direction: resume.direction });
      const qs = r.questions ?? questions;
      const as = r.answers ?? answers;
      if (qs?.length && as?.length) ctx.store.insertQuestionnaireAnswers(app.id, qs, as);
      stats.record(status, vacancy);
      // r.status (pre dry-run remap) is SENT for both a real send and a simulated dry-run send, so a
      // dry run reserves the same in-run company slot a real run would.
      if (r.status === Status.SENT && companyKey) companyTracker.reserve(companyKey, resume.direction);
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

/** The human overrode a filter: fetch if needed, ask decide only for the resume + letter, force apply=true
 * and send through the normal apply path with no company quota / persona lock / daily limit. */
async function forceApply(ctx: RunContext, u: UserRun, id: number, pool: HHResume[]): Promise<void> {
  const { user, profile, stats } = u;
  const row = ctx.store.getApplication(id);
  if (!row || row.application.userId !== user.id || row.vacancy.source !== "hh") return ctx.log.error("apply", `hh application ${id} not found for ${user.slug}`);
  let vacancy = row.vacancy;
  if (ctx.store.hasSentApplication(user.id, vacancy.id)) return ctx.log.warn("apply", `${vacancy.title}: already sent`);
  if (!pool.length) throw new Error(`no hh resumes in the pool for ${user.slug}; run pool sync first`);
  if (!vacancy.descriptionText) {
    const s = await ctx.browser.openHH(user);
    const r = await ctx.hh.fetchVacancy(s, { externalId: vacancy.externalId, url: vacancy.url, title: vacancy.title, company: vacancy.company, salaryRaw: "" });
    vacancy = ctx.store.upsertVacancy({ ...r.vacancy, id: vacancy.id });
    const skip = r.alreadyApplied ? Status.SKIP_ALREADY_APPLIED : vacancy.archived ? Status.SKIP_ARCHIVED : null;
    if (skip) {
      stats.record(skip);
      ctx.store.insertApplication(newApp(ctx, user.id, vacancy.id, skip, "forced by user"));
      return ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${skip}`);
    }
  }
  await ctx.browser.close();
  await ctx.memoryGuard("decide");
  const [d] = await ctx.llm.decide({ profile, resumes: pool, vacancies: [vacancy], lessons: readLessons(ctx.store, user.id).lessons, kb: decideKb(ctx.store, user.id) });
  stats.llmCall();
  const was = `forced by user (was ${row.application.status}${row.application.reasonDetail ? `: ${row.application.reasonDetail}` : ""})`;
  const decision: Decision = { ...(d ?? { resume_id: "", cover_letter: "", direction: "", seniority: "", red_flags: [] }), vacancy_id: vacancy.id, apply: true, reason: `${was}${d?.reason ? `; LLM: ${d.reason}` : ""}` };
  ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${was}`, { vacancy_id: vacancy.id, application_id: id });
  await applyStage(ctx, u, [{ vacancy, decision, companyKey: "", lockedDirection: "" }], pool, 1, createRunCompanyTracker());
}

/**
 * Poor fit → a resume tailored to this vacancy: a new copy of the chosen resume while hh capacity and
 * user.poolExpandPerDay allow, else the chosen resume (a generated one of the same direction when
 * there is one, to spare hand-made originals) rewritten in place. Only a stop propagates: any failure keeps
 * the original resume so the application still goes out.
 */
export async function tailorResume(ctx: RunContext, u: UserRun, s: BrowserSession, decision: Decision, resume: HHResume, pool: HHResume[], lock: string): Promise<HHResume> {
  const t = decision.tailored;
  if (decision.resume_fit !== "poor" || !t) return resume;
  const direction = decision.direction || resume.direction;
  if (lock && direction !== lock) {
    ctx.log.info("apply", `tailor skipped: company locked to "${lock}", tailored direction "${direction}"`);
    return resume;
  }
  const { user } = u;
  const edit = { title: t.title, about: t.about, keySkills: t.key_skills };
  const summary = { direction, seniority: decision.seniority, key_skills: t.key_skills, one_line: t.about.slice(0, 200) };
  try {
    const cap = await ctx.hh.resumeCapacity(s);
    const createdToday = ctx.store.countHHResumesCreatedToday(user.id, dayInTz(ctx.now(), ctx.cfg.tz));
    // A resume already sent to an employer is never edited: hh shows employers the live version, so a
    // rewrite would change what earlier employers see. Tailoring only ever creates a new copy.
    const same = pool.find((r) => r.title.trim().toLowerCase() === t.title.trim().toLowerCase());
    if (same) {
      // An earlier vacancy already produced this resume: apply with it instead of the generic one.
      ctx.log.info("apply", `tailor: reusing existing resume "${same.title}"`);
      return same;
    }
    if (cap.created >= cap.max || createdToday >= user.poolExpandPerDay) {
      ctx.log.info("apply", `tailor: no room for a new resume (capacity ${cap.created}/${cap.max}, created today ${createdToday}/${user.poolExpandPerDay}), using "${resume.title}"`);
      return resume;
    }
    const what = `create "${t.title}" from "${resume.title}"`;
    if (ctx.req.dryRun) {
      ctx.log.info("apply", `[dry-run] would ${what} (capacity ${cap.created}/${cap.max}, created today ${createdToday})`);
      return resume;
    }
    const newId = await ctx.hh.duplicateResume(s, resume.hhResumeId, edit);
    const row = ctx.store.upsertHHResume({ userId: user.id, hhResumeId: newId, title: t.title, url: `https://hh.ru/resume/${newId}`, direction, summary, isGenerated: true, syncedAt: ctx.now().toISOString() });
    pool.push(row);
    // hh creates the copy as a draft; employers must never get a draft, so apply with it only once published.
    if (!(await ctx.hh.publishResume(s, newId))) {
      ctx.log.warn("apply", `tailor: "${t.title}" created but not published, applying with "${resume.title}"`, { hh_resume_id: newId });
      await ctx.throttle.afterMutation();
      return resume;
    }
    ctx.log.info("apply", `tailored: ${what}`, { hh_resume_id: row.hhResumeId });
    await ctx.throttle.afterMutation();
    return row;
  } catch (e) {
    if (e instanceof RunAbortError || isStop(e)) throw e;
    ctx.log.warn("apply", `tailor failed, applying with "${resume.title}": ${errMessage(e)}`);
    await ctx.throttle.afterMutation();
    return resume;
  }
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
  ctx.store.setSetting("touch_last_at", ctx.now().toISOString()); // the serve autopilot raises again ~4h later
  ctx.log.info("touch", `done: ${ok}/${pool.length} resumes touched`, { touched: ok });
}

/** hh professional roles searched (IT category): developer, DevOps, QA, data scientist, systems engineer.
 * Without it short queries like «go» return couriers and marketers that only burn fetch + decide time.
 * ponytail: one list for every user; move to profile when a non-developer user appears. */
export const IT_ROLES = ["96", "160", "124", "165", "114"];

export function newApp(ctx: RunContext, userId: number, vacancyId: number, status: Status, detail: string) {
  return { userId, vacancyId, hhResumeId: null, generatedResumeId: null, runId: ctx.run.id, status, reasonDetail: detail, coverLetter: "", llmDecision: null, direction: "" };
}
