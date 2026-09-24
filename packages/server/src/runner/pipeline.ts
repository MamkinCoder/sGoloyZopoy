// Run orchestration: users → sources → stages. Decides the final run status and sends reports.
import { RunAbortError, type Run, type RunStatus, type User } from "@sgz/shared";
import { runCareerUser, type CareerPlan } from "./career.js";
import type { RunContext } from "./context.js";
import { runHabrUser, type HabrPlan } from "./habr.js";
import { runHHUser, type HHPlan } from "./hh.js";
import { createStats, mergeStats } from "./stats.js";
import type { UserRun } from "./user.js";
import { errMessage, RunStoppedError } from "./util.js";

export interface PipelineResult {
  status: RunStatus;
  error: string;
  /** Users that were processed (fully or partially), with their stats — one report each. */
  users: UserRun[];
}

export function planHH(source: string, stage: string | undefined): HHPlan | null {
  if (source === "career" || source === "habr") return null;
  // Runs never talk to employers: chats belong to the always-on agent (src/agent/chats).
  const full: HHPlan = { poolSync: "auto", search: true, decide: true, apply: true, touch: true, poolExpand: true, force: null };
  const none: HHPlan = { poolSync: "off", search: false, decide: false, apply: false, touch: false, poolExpand: false, force: null };
  if (source === "pool") {
    if (!stage || stage === "pool-sync" || stage === "sync") return { ...none, poolSync: "force" };
    if (stage === "pool-expand" || stage === "expand") return { ...none, poolSync: "auto", poolExpand: true };
    if (stage === "touch") return { ...none, touch: true };
    return null;
  }
  if (!stage) return full;
  const force = /^force:(\d+)$/.exec(stage);
  if (force) return source === "hh" ? { ...none, poolSync: "auto", force: Number(force[1]) } : null;
  switch (stage) {
    case "search":
    case "fetch":
      return { ...none, poolSync: "auto", search: true };
    case "decide":
      return { ...none, poolSync: "auto", search: true, decide: true };
    case "apply":
      return { ...none, poolSync: "auto", search: true, decide: true, apply: true };
    case "touch":
      return { ...none, touch: true };
    case "pool-sync":
      return { ...none, poolSync: "force" };
    case "pool-expand":
      return { ...none, poolSync: "auto", poolExpand: true };
    default:
      return null;
  }
}

/** Habr Career: its own source, and part of "all" (the daily run). */
export function planHabr(source: string, stage: string | undefined): HabrPlan | null {
  if (source !== "habr" && source !== "all") return null;
  const none: HabrPlan = { search: false, decide: false, apply: false, force: null };
  if (!stage) return { search: true, decide: true, apply: true, force: null };
  const force = /^force:(\d+)$/.exec(stage);
  if (force) return source === "habr" ? { ...none, force: Number(force[1]) } : null;
  switch (stage) {
    case "search":
    case "fetch":
      return { ...none, search: true };
    case "decide":
      return { ...none, search: true, decide: true };
    case "apply":
      return { ...none, search: true, decide: true, apply: true };
    default:
      return null;
  }
}

export function planCareer(source: string, stage: string | undefined): CareerPlan | null {
  if (source !== "career" && source !== "all") return null;
  // "all" without a stage (the daily run) is hh + habr: career sites are covered by the autopilot's rotate chunks.
  if (source === "all" && !stage) return null;
  const plan: CareerPlan = { onboardOnly: null, siteOnly: null, discover: true, apply: true, target: null, rotate: false };
  if (!stage) return plan;
  if (stage.startsWith("onboard:")) {
    const id = Number(stage.slice("onboard:".length));
    return Number.isFinite(id) ? { ...plan, onboardOnly: id, discover: false, apply: false } : null;
  }
  const target = /^(send|inspect|force|retailor):(\d+)$/.exec(stage);
  if (target) return { ...plan, discover: false, apply: false, target: { applicationId: Number(target[2]), mode: target[1] as "send" | "inspect" | "force" | "retailor" } };
  if (stage === "search" || stage === "fetch" || stage === "discover") return { ...plan, apply: false };
  if (stage === "apply" || stage === "tailor") return plan;
  if (stage === "rotate") return { ...plan, rotate: true };
  const site = /^site:(\d+)$/.exec(stage);
  if (site) return { ...plan, siteOnly: Number(site[1]) };
  return null;
}

function resolveUsers(ctx: RunContext): User[] {
  if (ctx.req.userSlug === "all") return ctx.store.listUsers(true);
  const u = ctx.store.getUserBySlug(ctx.req.userSlug);
  if (!u) throw new Error(`unknown user "${ctx.req.userSlug}"`);
  return [u];
}

export async function runPipeline(ctx: RunContext): Promise<PipelineResult> {
  const { req } = ctx;
  const users = resolveUsers(ctx);
  const hhPlan = planHH(req.source, req.stage);
  const careerPlan = planCareer(req.source, req.stage);
  const habrPlan = ctx.deps.habr ? planHabr(req.source, req.stage) : null;
  if (!hhPlan && !careerPlan && !habrPlan) throw new Error(`nothing to do for source=${req.source} stage=${req.stage ?? "-"}`);
  ctx.log.info("session", `run #${ctx.run.id}: ${users.map((u) => u.slug).join(", ") || "no users"} · source=${req.source}${req.stage ? ` stage=${req.stage}` : ""}${req.dryRun ? " · dry-run" : ""}`, {
    users: users.map((u) => u.slug),
    source: req.source,
    stage: req.stage ?? null,
    dry_run: req.dryRun,
  });

  const done: UserRun[] = [];
  let status: RunStatus = "done";
  let error = "";
  for (const user of users) {
    const profile = ctx.store.getProfile(user.id);
    if (!profile) {
      ctx.log.warn("session", `${user.slug}: no profile, skipping`);
      continue;
    }
    const ur: UserRun = { user, profile, stats: createStats(req.dryRun) };
    done.push(ur);
    try {
      ctx.checkAbort();
      if (hhPlan) await runHHUser(ctx, ur, hhPlan);
      if (habrPlan) await runHabrContained(ctx, ur, habrPlan);
      if (careerPlan) await runCareerUser(ctx, ur, careerPlan);
      await ctx.browser.close();
    } catch (e) {
      await ctx.browser.close().catch(() => undefined);
      if (e instanceof RunStoppedError) {
        status = "stopped";
        error = "stopped by request";
        ctx.log.warn("session", `${user.slug}: ${error}`);
        break;
      }
      if (e instanceof RunAbortError) {
        status = "stopped";
        error = `${e.status}: ${e.message}`;
        ctx.log.error("session", `${user.slug}: fatal ${error}`, { status: e.status });
        ur.stats.record(e.status);
        await alert(ctx, `Прогон #${ctx.run.id} остановлен: ${e.status}`, `${user.name}: ${e.message}`);
        break;
      }
      status = "failed";
      error = errMessage(e);
      ctx.log.error("session", `${user.slug}: ${error}`, { stack: e instanceof Error ? e.stack : undefined });
      await alert(ctx, `Прогон #${ctx.run.id} упал`, `${user.name}: ${error}`);
      break;
    }
  }
  return { status, error, users: done };
}

/**
 * Habr runs inside "all" next to hh and career: a Habr block (login expired, captcha) must not stop the
 * rest of the run. Its fatal errors are logged and alerted once a day instead of aborting the run.
 */
async function runHabrContained(ctx: RunContext, ur: UserRun, plan: HabrPlan): Promise<void> {
  try {
    await runHabrUser(ctx, ur, plan);
  } catch (e) {
    if (!(e instanceof RunAbortError) || ctx.req.source === "habr") throw e;
    ur.stats.record(e.status);
    ctx.log.error("session", `${ur.user.slug}: habr skipped: ${e.status}: ${e.message}`, { status: e.status });
    const key = `habr_alert_day:${ur.user.id}`;
    const day = ctx.now().toISOString().slice(0, 10);
    if (ctx.store.getSetting(key) !== day) {
      ctx.store.setSetting(key, day);
      await alert(ctx, `Хабр Карьера: ${e.status}`, `${ur.user.name}: ${e.message}`);
    }
  } finally {
    await ctx.browser.close().catch(() => undefined); // the next source relaunches and re-checks its own login
  }
}

/** Per-user Telegram reports; returns true when at least one was delivered. */
export async function sendReports(ctx: RunContext, run: Run, users: UserRun[]): Promise<boolean> {
  let sent = false;
  for (const u of users) {
    try {
      await ctx.deps.notifier.report(u.user, { ...run, userId: u.user.id, stats: u.stats.snapshot() });
      sent = true;
      ctx.log.info("report", `${u.user.slug}: report sent`);
    } catch (e) {
      ctx.log.warn("report", `${u.user.slug}: report failed: ${errMessage(e)}`);
    }
  }
  return sent;
}

export const aggregate = (users: UserRun[], dryRun: boolean) => mergeStats(users.map((u) => u.stats.snapshot()), dryRun);

async function alert(ctx: RunContext, title: string, body: string): Promise<void> {
  try {
    await ctx.deps.notifier.alert(title, body);
  } catch (e) {
    ctx.log.warn("report", `alert failed: ${errMessage(e)}`);
  }
}
