// RunService: one run at a time (the batch plane), async pipeline, live events via the hub. Employer chats
// are not runs: the always-on agent (src/agent) answers them.
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
  /** Resolves once the active runs (if any) have finished. For graceful shutdown. */
  drain(): Promise<void>;
}

/** Cleanup awaits after the pipeline (browser close) get this long: a wedged Chrome must not hold the slot. */
const CLEANUP_MS = 15_000;
const within = (p: Promise<unknown>, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => undefined), new Promise((r) => (t = setTimeout(r, ms)))]).finally(() => clearTimeout(t));
};

/** Watchdog limit for one run: short stages get tight caps, `run_max_min` (minutes, >0) overrides all. */
export function maxRunMs(req: Pick<RunRequest, "stage">, override: string | null): number {
  const o = Number(override);
  if (override && Number.isFinite(o) && o > 0) return o * 60_000;
  const st = req.stage ?? "";
  if (st === "touch") return 20 * 60_000;
  if (st === "rotate" || /^(send|inspect|retailor|force):/.test(st)) return 30 * 60_000;
  return 150 * 60_000;
}

/** After the watchdog aborts, a wedged await that never reaches checkAbort gets this long before the runner moves on. */
export const WATCHDOG_GRACE_MS = 60_000;

const BACKGROUND_STAGES = new Set(["rotate", "touch"]);
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
  const find = (runId: number) => (active?.run.id === runId ? active : null);

  async function execute(run: Run, req: RunRequest, controller: AbortController): Promise<Run> {
    const log = createRunLogger(store, hub, run.id, stderr);
    const ctx = createContext(deps, run, req, log, controller.signal);
    let final: Run = { ...run };
    let piped = false; // the pipeline returned; only the report was left
    // Watchdog: a hung page, LLM call or Telegram send must not hold the slot all day. It races the whole
    // body (pipeline + report): after it gives up nothing here awaits anything unbounded.
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
    const body = async () => {
      const r = await runPipeline(ctx);
      final = { ...run, status: r.status, error: r.error, stats: aggregate(r.users, req.dryRun), finishedAt: ctx.now().toISOString() };
      piped = true;
      // Autopilot career chunks and touches run all day: report only when something happened.
      const s = final.stats;
      const quietPoll =
        req.trigger === "schedule" &&
        final.status === "done" &&
        ((req.stage === "rotate" && !s.by_status.QUEUED) || req.stage === "touch");
      const repeated = final.status !== "done" && repeatFailure(store, req, final.error, ctx.now());
      if (!quietPoll && !repeated) final.tgSent = await sendReports(ctx, final, r.users);
    };
    try {
      await Promise.race([body(), watchdog]);
    } catch (e) {
      // Bounded: a browser launched after the watchdog's close, on a wedged Chrome, never finishes closing.
      await within(ctx.browser.close(), CLEANUP_MS);
      if (!piped) {
        final = { ...run, status: "failed", error: errMessage(e), finishedAt: ctx.now().toISOString() };
        log.error("session", `run failed: ${final.error}`, { stack: e instanceof Error ? e.stack : undefined });
        if (!timedOut && !repeatFailure(store, req, final.error, ctx.now())) void deps.notifier.alert(`Прогон #${run.id} упал`, final.error).catch((ae: unknown) => log.warn("report", `alert failed: ${errMessage(ae)}`));
      }
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
      const run = { ...store.insertRun({ userId, source: req.source, trigger: req.trigger, status: "running", stats: emptyRunStats(req.dryRun), tgSent: false, error: "" }), stage: req.stage };
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
      const a = find(runId);
      if (a) {
        a.controller.abort();
        return;
      }
      // A run left "running" by a crashed process: close it so the panel stops showing it as active.
      const r = store.getRun(runId);
      if (r && (r.status === "running" || r.status === "queued")) store.finishRun({ ...r, status: "stopped", error: "stopped (no active worker)", finishedAt: new Date().toISOString() });
    },

    active: () => (active ? { ...active.run } : null),

    subscribe: (runId): AsyncIterable<RunEvent> => hub.subscribe(runId),

    async wait(runId) {
      const a = find(runId);
      if (a) return a.promise;
      const r = store.getRun(runId);
      if (!r) throw new Error(`run ${runId} not found`);
      return r;
    },

    async drain() {
      await active?.promise.catch(() => undefined);
    },
  };
}
