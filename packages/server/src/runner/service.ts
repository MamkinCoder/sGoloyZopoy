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

export function createRunner(deps: RunnerDeps): Runner {
  const hub = new EventHub();
  const store = deps.store;
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  let active: Active | null = null;

  async function execute(run: Run, req: RunRequest, controller: AbortController): Promise<Run> {
    const log = createRunLogger(store, hub, run.id, stderr);
    const ctx = createContext(deps, run, req, log, controller.signal);
    let final: Run = { ...run };
    try {
      const r = await runPipeline(ctx);
      final = { ...run, status: r.status, error: r.error, stats: aggregate(r.users, req.dryRun), finishedAt: ctx.now().toISOString() };
      final.tgSent = await sendReports(ctx, final, r.users);
    } catch (e) {
      await ctx.browser.close().catch(() => undefined);
      final = { ...run, status: "failed", error: errMessage(e), finishedAt: ctx.now().toISOString() };
      log.error("session", `run failed: ${final.error}`, { stack: e instanceof Error ? e.stack : undefined });
      await deps.notifier.alert(`Прогон #${run.id} упал`, final.error).catch((ae: unknown) => log.warn("report", `alert failed: ${errMessage(ae)}`));
    }
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
