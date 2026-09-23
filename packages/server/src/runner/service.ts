// RunService: one run at a time, async pipeline, live events via the hub.
import { emptyRunStats, RunBusyError, type Run, type RunEvent, type RunRequest, type RunService } from "@sgz/shared";
import { createContext } from "./context.js";
import type { RunnerDeps } from "./deps.js";
import { EventHub } from "./hub.js";
import { createRunLogger } from "./logger.js";
import { aggregate, runPipeline, sendReports } from "./pipeline.js";
import { errMessage } from "./util.js";

interface Active {
  run: Run;
  controller: AbortController;
  promise: Promise<Run>;
}

export interface Runner extends RunService {
  /** Resolves once the active run (if any) has finished. For graceful shutdown. */
  drain(): Promise<void>;
}

/** Watchdog limit for one run: short stages get tight caps, `run_max_min` (minutes, >0) overrides all. */
export function maxRunMs(req: Pick<RunRequest, "stage">, override: string | null): number {
  const o = Number(override);
  if (override && Number.isFinite(o) && o > 0) return o * 60_000;
  const st = req.stage ?? "";
  if (st === "chats" || st === "touch") return 20 * 60_000;
  if (st === "rotate" || /^(send|inspect|retailor|force):/.test(st)) return 30 * 60_000;
  return 150 * 60_000;
}

/** After the watchdog aborts, a wedged await that never reaches checkAbort gets this long before the runner moves on. */
export const WATCHDOG_GRACE_MS = 60_000;

const BACKGROUND_STAGES = new Set(["chats", "rotate", "touch"]);
const REPEAT_ALERT_MS = 3 * 3600_000;

/** Autopilot runs repeat every few minutes: the same failure (e.g. an expired hh login) is reported
 * once per 3h instead of on every poll. Manual and full runs always report. Digits are ignored so
 * "run #51"/timings don't make the same error look new. */
export function repeatFailure(store: Pick<RunnerDeps["store"], "getSetting" | "setSetting">, req: RunRequest, error: string, now: Date): boolean {
  if (req.trigger !== "schedule" || !BACKGROUND_STAGES.has(req.stage ?? "")) return false;
  const key = `alert_last:${error.replace(/\d+/g, "#").slice(0, 80)}`;
  const last = Date.parse(store.getSetting(key) ?? "");
  if (Number.isFinite(last) && now.getTime() - last < REPEAT_ALERT_MS) return true;
  store.setSetting(key, now.toISOString());
  return false;
}

export function createRunner(deps: RunnerDeps): Runner {
  const hub = new EventHub();
  const store = deps.store;
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  let active: Active | null = null;

  async function execute(run: Run, req: RunRequest, controller: AbortController): Promise<Run> {
    const log = createRunLogger(store, hub, run.id, stderr);
    const ctx = createContext(deps, run, req, log, controller.signal);
    let final: Run = { ...run };
    // Watchdog: a hung page or LLM call must not hold the single runner (and the chat bot) all day.
    const limitMs = maxRunMs(req, store.getSetting("run_max_min"));
    let timedOut = "";
    let grace: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = `watchdog: exceeded ${Math.round(limitMs / 60_000)} min`;
        log.error("session", timedOut);
        controller.abort();
        void ctx.browser.close().catch(() => undefined);
        void deps.notifier.alert(`Прогон #${run.id} остановлен сторожем`, `идёт дольше ${Math.round(limitMs / 60_000)} мин (${req.source}/${req.stage ?? "full"})`).catch(() => undefined);
        grace = setTimeout(() => reject(new Error(timedOut)), WATCHDOG_GRACE_MS);
      }, limitMs);
    });
    watchdog.catch(() => undefined);
    try {
      const r = await Promise.race([runPipeline(ctx), watchdog]);
      final = { ...run, status: r.status, error: r.error, stats: aggregate(r.users, req.dryRun), finishedAt: ctx.now().toISOString() };
      // Chat polls and autopilot career chunks run all day: report only when something happened.
      const s = final.stats;
      const quietPoll =
        req.trigger === "schedule" &&
        final.status === "done" &&
        ((req.stage === "chats" && !s.chat_replies && !s.invitations && !s.rejections) || (req.stage === "rotate" && !s.by_status.QUEUED) || req.stage === "touch");
      const repeated = final.status !== "done" && repeatFailure(store, req, final.error, ctx.now());
      if (!quietPoll && !repeated) final.tgSent = await sendReports(ctx, final, r.users);
    } catch (e) {
      await ctx.browser.close().catch(() => undefined);
      final = { ...run, status: "failed", error: errMessage(e), finishedAt: ctx.now().toISOString() };
      log.error("session", `run failed: ${final.error}`, { stack: e instanceof Error ? e.stack : undefined });
      if (!timedOut && !repeatFailure(store, req, final.error, ctx.now())) await deps.notifier.alert(`Прогон #${run.id} упал`, final.error).catch((ae: unknown) => log.warn("report", `alert failed: ${errMessage(ae)}`));
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
    }
    if (timedOut) final.error = timedOut;
    try {
      store.finishRun(final);
    } catch (e) {
      stderr(`[run ${run.id}] finishRun failed: ${errMessage(e)}`);
    }
    log.info("report", `run #${run.id} ${final.status}${final.error ? `: ${final.error}` : ""}`, { status: final.status, sent: final.stats.by_status.SENT ?? 0 });
    Object.assign(run, final);
    return final;
  }

  return {
    async start(req) {
      if (active) throw new RunBusyError();
      const userId = req.userSlug === "all" ? null : (store.getUserBySlug(req.userSlug)?.id ?? null);
      if (req.userSlug !== "all" && userId === null) throw new Error(`unknown user "${req.userSlug}"`);
      const run = store.insertRun({ userId, source: req.source, trigger: req.trigger, status: "running", stats: emptyRunStats(req.dryRun), tgSent: false, error: "" });
      hub.open(run.id);
      const controller = new AbortController();
      const entry: Active = { run, controller, promise: Promise.resolve(run) };
      active = entry;
      entry.promise = execute(run, req, controller).finally(() => {
        if (active === entry) active = null;
        hub.close(run.id);
      });
      // Nothing may escape: the promise is also awaited by wait(), so swallow here.
      entry.promise.catch(() => undefined);
      return run.id;
    },

    async stop(runId) {
      if (active && active.run.id === runId) {
        active.controller.abort();
        return;
      }
      // A run left "running" by a crashed process: close it so the panel stops showing it as active.
      const r = store.getRun(runId);
      if (r && (r.status === "running" || r.status === "queued")) store.finishRun({ ...r, status: "stopped", error: "stopped (no active worker)", finishedAt: new Date().toISOString() });
    },

    active: () => (active ? { ...active.run } : null),

    subscribe: (runId): AsyncIterable<RunEvent> => hub.subscribe(runId),

    async wait(runId) {
      if (active && active.run.id === runId) return active.promise;
      const r = store.getRun(runId);
      if (!r) throw new Error(`run ${runId} not found`);
      return r;
    },

    async drain() {
      if (active) await active.promise.catch(() => undefined);
    },
  };
}
