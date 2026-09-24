// hh.ru stages for one user. Sequential; browser closed for the LLM batch (decide); abort checked
// between items so stop() takes effect quickly.
import { RunAbortError, Status, type Answer, type BrowserSession, type Decision, type HHResume, type Question } from "@sgz/shared";
import { forceApply, newApp, runBoard, sendFailed, type Board } from "./board.js";
import { dailyBudget } from "./budget.js";
import type { RunContext } from "./context.js";
import { createRunCompanyTracker } from "./filters.js";
import { expandPool, syncPool, syncIsStale } from "./pool.js";
import { kbForVacancy } from "../kb/context.js";
import { renderQuestions } from "../llm/format.js";
import { viewersStage } from "./viewers.js";
import { dayInTz } from "../scheduler/tz.js";
import type { UserRun } from "./user.js";
import { errMessage, isStop } from "./util.js";

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
  const board = hhBoard(ctx, u, pool);
  if (plan.force !== null) return forceApply(ctx, u, board, plan.force, pool);

  // Warm leads first: employers who opened a resume get the budget before cold search does.
  if (plan.apply && budget > 0) budget = await viewersStage(ctx, u, pool, budget, companyTracker);
  await runBoard(ctx, u, board, plan, pool, budget, companyTracker);
  if (plan.touch) await touchStage(ctx, u, pool.length ? pool : ctx.store.listHHResumes(user.id));
  if (plan.poolExpand) await expandPool(ctx, u, pool.length ? pool : ctx.store.listHHResumes(user.id));
}

/** hh.ru as a Board: search in the IT roles, fetch skips (applied, archived, test), send with the pool's resume
 * (honouring the company's persona lock, a tailored copy on a poor fit) and the questionnaire answered. */
export function hhBoard(ctx: RunContext, u: UserRun, pool: HHResume[]): Board {
  const { user, profile, stats } = u;
  return {
    source: "hh",
    maxPages: 5,
    open: () => ctx.browser.openHH(user),
    async search(s, query, page) {
      const cards = await ctx.hh.search(s, { query, page, period: 1, area: profile.hh_area || undefined, roles: IT_ROLES });
      return cards.length ? { cards, more: true } : null;
    },
    async fetch(s, c, forced) {
      const r = await ctx.hh.fetchVacancy(s, c.card);
      const v = ctx.store.upsertVacancy({ ...r.vacancy, id: c.vacancy.id });
      const skip = r.alreadyApplied ? Status.SKIP_ALREADY_APPLIED : v.archived ? Status.SKIP_ARCHIVED : v.hasTest && !forced ? Status.SKIP_TEST_REQUIRED : null;
      if (!skip) return v;
      stats.record(skip);
      ctx.store.insertApplication(newApp(ctx, user.id, v.id, skip, forced ? "forced by user" : ""));
      ctx.log.info(forced ? "apply" : "fetch", `${v.title} @ ${v.company}: ${skip}`);
      return null;
    },
    async send(a, o, skip) {
      const { vacancy, decision, companyKey } = a;
      let resume = pool.find((r) => r.hhResumeId === decision.resume_id) ?? pool[0];
      if (!resume) throw new Error("empty resume pool at apply stage");
      // Candidates approved earlier in this run may have locked the company to a different CV direction.
      const effectiveLock = a.lockedDirection || o.runTracker.lockedDirection(companyKey);
      if (o.company.personaLockEnabled && effectiveLock && resume.direction !== effectiveLock) {
        const matching = pool.find((r) => r.direction === effectiveLock);
        if (!matching) {
          skip(Status.SKIP_COMPANY_PERSONA, `company locked to direction "${effectiveLock}", no matching resume in pool`);
          return false;
        }
        resume = matching;
      }
      const s = await ctx.browser.openHH(user);
      resume = await tailorResume(ctx, u, s, decision, resume, pool, o.company.personaLockEnabled ? effectiveLock : "");
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
        if (r.status === Status.SENT && companyKey) o.runTracker.reserve(companyKey, resume.direction);
        ctx.log.info("apply", `${vacancy.title} @ ${vacancy.company}: ${status}${r.reasonDetail ? ` (${r.reasonDetail})` : ""}`, { vacancy_id: vacancy.id, status, resume: resume.title });
        if (r.status === Status.SENT || r.status === Status.SKIP_DRY_RUN || r.status.startsWith("FAILED_")) await ctx.throttle.afterMutation();
        else await ctx.throttle.afterRead();
        return status === Status.SENT;
      } catch (e) {
        return sendFailed(ctx, u, "", a, e, { hhResumeId: resume.id });
      }
    },
  };
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
