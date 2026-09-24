// Habr Career stages for one user: search (logged-in listing) → filters → fetch → decide (the hh decide
// with a one-resume pool: Habr allows one profile) → apply with a cover letter, no review queue. Same browser
// and Chrome profile as hh, Habr cookies injected. Habr conversations: the always-on agent (src/agent/chats).
import { notifierFor, Status, type HHResume, type User } from "@sgz/shared";
import { MIN_RESPONSES_LEFT, type HabrClient } from "../habr/client.js";
import type { HabrCard } from "../habr/state.js";
import { dayInTz } from "../scheduler/tz.js";
import { BoardExhausted, forceApply, newApp, runBoard, sendFailed, type Board } from "./board.js";
import { dailyBudget } from "./budget.js";
import type { RunContext } from "./context.js";
import { createRunCompanyTracker, recordSkip } from "./filters.js";
import type { UserRun } from "./user.js";

export interface HabrPlan {
  search: boolean;
  decide: boolean;
  apply: boolean;
  /** Stage force:<applicationId>: apply to that one filtered-out Habr vacancy. */
  force: number | null;
}

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

export async function runHabrUser(ctx: RunContext, u: UserRun, plan: HabrPlan): Promise<void> {
  const habr = ctx.deps.habr;
  if (!habr) return ctx.log.warn("session", "habr: client not configured, skipping");
  const { user } = u;
  const pool = habrPool(user, u.profile);
  const board = habrBoard(ctx, u, habr);
  if (plan.force !== null) return forceApply(ctx, u, board, plan.force, pool);
  const budget = dailyBudget(ctx.store, user, ["habr"], habrDailyLimit(ctx), ctx.req.limit, ctx.now(), ctx.cfg.tz);
  ctx.log.info("session", `habr: user ${user.slug}, budget ${budget}, dry_run=${ctx.req.dryRun}`, { budget, day: dayInTz(ctx.now(), ctx.cfg.tz) });
  try {
    await runBoard(ctx, u, board, plan, pool, budget, createRunCompanyTracker());
  } catch (e) {
    if (!(e instanceof BoardExhausted)) throw e;
    ctx.log.warn("apply", e.message);
    if (!ctx.req.dryRun) await notifierFor(ctx.deps.notifier, user).alert("Хабр Карьера: отклики заканчиваются", `${user.name}: ${e.message}. Автоотклики на Хабре остановлены до пополнения лимита.`).catch(() => undefined);
  }
}

/** Habr Career as a Board: the logged-in listing (IT-only, so no role filter), the vacancy page's response state
 * decides the skips, the send is a response with the letter. Stops once the response allowance runs low. */
function habrBoard(ctx: RunContext, u: UserRun, habr: HabrClient): Board<HabrCard> {
  const { user, stats } = u;
  const exhausted = (left: number | null) => {
    if (left !== null && left < MIN_RESPONSES_LEFT) throw new BoardExhausted(`only ${left} Habr responses left`);
  };
  return {
    source: "habr",
    maxPages: 3,
    open: () => ctx.browser.openHabr(user),
    async search(s, query, page) {
      const { cards, totalPages } = await habr.search(s, query, page);
      return { cards, more: page + 1 < totalPages };
    },
    drop(card, vacancy) {
      if (card.alreadyApplied) {
        if (!ctx.store.hasSentApplication(user.id, vacancy.id)) recordSkip(ctx.store, newApp(ctx, user.id, vacancy.id, Status.SKIP_ALREADY_APPLIED, "Habr listing: already responded"));
        return true;
      }
      // Archived and external-apply stay that way: don't re-fetch them every run (they would crowd out new ones).
      const last = ctx.store.lastApplication(user.id, vacancy.id);
      return !!last && (last.status === Status.SKIP_ARCHIVED || (last.status === Status.SKIP_FILTER && last.reasonDetail.startsWith("response kind")));
    },
    async fetch(s, c, forced) {
      const r = await habr.fetchVacancy(s, c.vacancy);
      const v = ctx.store.upsertVacancy({ ...r.vacancy, id: c.vacancy.id });
      if (forced) return v;
      const st = r.state;
      exhausted(st.responsesLeft);
      const skip: [Status, string] | null =
        st.responded || st.kind === "applied" ? [Status.SKIP_ALREADY_APPLIED, "Habr shows our response"]
        : v.archived ? [Status.SKIP_ARCHIVED, ""]
        : st.placeholder ? [Status.SKIP_FILTER, `no response form: ${st.placeholder}`]
        : st.kind !== "direct" ? [Status.SKIP_FILTER, `response kind «${st.kind || "none"}»: external apply`]
        : null;
      if (!skip) return v;
      stats.record(skip[0]);
      recordSkip(ctx.store, newApp(ctx, user.id, v.id, skip[0], skip[1]));
      ctx.log.info("fetch", `${v.title} @ ${v.company}: ${skip[0]}${skip[1] ? ` (${skip[1]})` : ""}`);
      return null;
    },
    async send(a, o) {
      const { vacancy, decision, companyKey } = a;
      const s = await ctx.browser.openHabr(user);
      try {
        const r = await habr.apply(s, { vacancy, coverLetter: decision.cover_letter, dryRun: ctx.req.dryRun });
        // A SENT row carries the letter only when Habr saved it: the panel and the lessons read it as delivered.
        const coverLetter = r.status === Status.SENT && r.reasonDetail !== "sent with letter" ? "" : decision.cover_letter;
        ctx.store.insertApplication({ ...newApp(ctx, user.id, vacancy.id, r.status, r.reasonDetail), coverLetter, llmDecision: decision, direction: decision.direction });
        stats.record(r.status, vacancy);
        if ((r.status === Status.SENT || r.status === Status.SKIP_DRY_RUN) && companyKey) o.runTracker.reserve(companyKey, decision.direction);
        ctx.log.info("apply", `habr ${vacancy.title} @ ${vacancy.company}: ${r.status}${r.reasonDetail ? ` (${r.reasonDetail})` : ""}`, { vacancy_id: vacancy.id, status: r.status, responses_left: r.responsesLeft });
        if (r.status === Status.SENT || r.status.startsWith("FAILED_")) await ctx.throttle.afterMutation();
        else await ctx.throttle.afterRead();
        exhausted(r.responsesLeft);
        return r.status === Status.SENT;
      } catch (e) {
        return sendFailed(ctx, u, "habr ", a, e);
      }
    },
  };
}
