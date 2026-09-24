// Warm leads: employers who opened one of the seeker's hh resumes («Кто смотрел резюме»). A new viewer's
// own open IT vacancies go through the normal filters -> fetch -> decide -> apply path (company limiter,
// daily budget, the usual honest letter that never mentions the view), at most MAX_APPLIES per run.
import { RunAbortError, Status, companyKey, type HHResume } from "@sgz/shared";
import type { RunContext } from "./context.js";
import { applyStage, decideStage, fetchStage, type Candidate } from "./board.js";
import { classify, ensureVacancy, filterOpts, skeletonVacancy, type RunCompanyTracker } from "./filters.js";
import { hhBoard, IT_ROLES } from "./hh.js";
import type { UserRun } from "./user.js";
import { errMessage, isStop, parseSalary } from "./util.js";

export const MAX_APPLIES = 3;
const MAX_EMPLOYERS = 5; // new viewers searched per run; the rest wait for the next one
const PER_EMPLOYER = 2;
const CHECK_EVERY_MS = 6 * 3600_000; // the views pages are read at most this often

export const viewerSeenKey = (userId: number, key: string): string => `viewer_seen:${userId}:${key}`;

interface Lead {
  key: string;
  employer: string;
  candidates: Candidate[];
}

/** Settings `viewers_enabled` = "0" turns it off. Returns the budget left. */
export async function viewersStage(ctx: RunContext, u: UserRun, pool: HHResume[], budget: number, tracker: RunCompanyTracker): Promise<number> {
  const { user, profile } = u;
  if (ctx.store.getSetting("viewers_enabled") === "0" || !pool.length || budget <= 0) return budget;
  const checkedKey = `viewers_checked_at:${user.id}`;
  const last = Date.parse(ctx.store.getSetting(checkedKey) ?? "");
  if (ctx.now().getTime() - last < CHECK_EVERY_MS) return budget;

  const s = await ctx.browser.openHH(user);
  const fresh = new Map<string, { employerId: string; employer: string }>();
  for (const r of pool) {
    ctx.checkAbort();
    try {
      for (const v of await ctx.hh.listResumeViewers(s, r.hhResumeId)) {
        const key = companyKey(v.employer);
        if (key && !fresh.has(key) && !ctx.store.getSetting(viewerSeenKey(user.id, key))) fresh.set(key, v);
      }
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.warn("viewers", `${r.title}: ${errMessage(e)}`);
    }
    await ctx.throttle.afterRead();
  }
  if (!ctx.req.dryRun) ctx.store.setSetting(checkedKey, ctx.now().toISOString());

  const o = filterOpts(ctx, tracker);
  const done: string[] = []; // viewers not worth a line: we already applied there, they are reading that
  const leads: Lead[] = [];
  for (const [key, v] of fresh) {
    if (ctx.store.countRecentApplicationsByCompany(user.id, key, "") > 0) {
      done.push(key);
      continue;
    }
    if (leads.length >= MAX_EMPLOYERS) continue;
    ctx.checkAbort();
    const lead: Lead = { key, employer: v.employer, candidates: [] };
    try {
      const cards = await ctx.hh.search(s, { query: "", employerId: v.employerId, period: 30, area: profile.hh_area || undefined, roles: IT_ROLES });
      for (const card of cards) {
        if (lead.candidates.length >= PER_EMPLOYER) break;
        const vacancy = ensureVacancy(ctx.store, skeletonVacancy("hh", card.externalId, card.url, card.title, card.company, parseSalary(card.salaryRaw)));
        const c = classify(ctx.store, user, profile, vacancy, o);
        if (c.kind === "candidate") lead.candidates.push({ card, vacancy, companyKey: c.companyKey, lockedDirection: c.lockedDirection });
      }
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.warn("viewers", `${v.employer}: search failed: ${errMessage(e)}`);
      continue; // retried next time
    }
    leads.push(lead);
    await ctx.throttle.afterRead();
  }
  ctx.log.info("viewers", `${fresh.size} new viewers, ${done.length} already applied to, ${leads.length} searched`, { fresh: fresh.size, leads: leads.length });

  let sent = 0;
  const candidates = leads.flatMap((l) => l.candidates);
  if (candidates.length) {
    const cap = Math.min(budget, MAX_APPLIES);
    const board = hhBoard(ctx, u, pool);
    const approved = await decideStage(ctx, u, await fetchStage(ctx, board, candidates, cap), pool);
    sent = cap - (await applyStage(ctx, u, board, approved.slice(0, cap), cap, tracker));
  }

  // A lead is finished once each candidate has a row (sent, rejected, failed); ones cut by the cap wait.
  const lines: string[] = [];
  for (const l of leads) {
    const rows = l.candidates.map((c) => ctx.store.lastApplication(user.id, c.vacancy.id));
    if (rows.length && rows.every((r) => !r)) continue;
    done.push(l.key);
    const hit = l.candidates.find((_, i) => rows[i]?.status === Status.SENT);
    lines.push(hit ? `Резюме смотрел ${l.employer} → откликнулся на «${hit.vacancy.title}»` : `Резюме смотрел ${l.employer}, подходящих открытых вакансий нет`);
  }
  if (ctx.req.dryRun) {
    if (lines.length) ctx.log.info("viewers", `[dry-run] would report:\n${lines.join("\n")}`);
    return budget;
  }
  for (const key of done) ctx.store.setSetting(viewerSeenKey(user.id, key), ctx.now().toISOString());
  if (lines.length) await ctx.deps.notifier.alert("Кто смотрел резюме", `${user.name}:\n${lines.join("\n")}`).catch(() => undefined);
  return budget - sent;
}
