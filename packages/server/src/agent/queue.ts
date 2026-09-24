// The always-on agent (docs/ARCHITECTURE.md §2): a persistent job queue worked by one loop inside `sgz serve`.
// Handlers are the unit of extension: a new always-on feature is a new job kind, not a new timer.
// Resources: at most one browser job (one agent Chrome), at most `llmSlots` LLM jobs, `none` jobs freely.
import type { EnqueueOptions, Job, JobState, Logger, Notifier, Store } from "@sgz/shared";
import type { JobsRepo } from "../db/jobs.js";
import { CLAUDE_PARALLEL } from "../llm/mutex.js";
import { errMessage } from "../runner/util.js";

export type Resource = "browser" | "llm" | "none";

export interface JobContext {
  now(): Date;
  enqueue: Agent["enqueue"];
  log: Logger;
}

export interface JobHandler {
  needs: Resource;
  /** Idempotent: reads its state from the DB. A throw retries with backoff until max attempts. */
  run(job: Job, ctx: JobContext): Promise<void>;
  /** Longest run before the job counts as hung (timeout = failed attempt) and its lease as expired. Default 10 min. */
  leaseMs?: number;
  /** Once, when the job exhausted its attempts (after the Telegram alert). */
  onFailed?(job: Job, error: string): void | Promise<void>;
}

/** A recurring job: enqueued by key every `everyMs` (the first one right at start). No due work, no job. */
export interface Schedule {
  kind: string;
  everyMs: number;
  payload?: Record<string, unknown>;
  /** Default: the kind. */
  key?: string;
}

export type AgentStore = JobsRepo & Pick<Store, "getSetting" | "setSetting">;

export interface AgentOptions {
  store: AgentStore;
  handlers: Record<string, JobHandler>;
  schedules?: Schedule[];
  notifier: Pick<Notifier, "alert">;
  /** The agent's Chrome: opened lazily by browser handlers, closed here after `browserIdleMs` without one. */
  browser?: { close(): Promise<void> };
  browserIdleMs?: number;
  llmSlots?: number;
  pollMs?: number;
  now?: () => Date;
  log?: Logger;
}

export interface Agent {
  enqueue(kind: string, payload?: Record<string, unknown>, opts?: EnqueueOptions): Job;
  /** Requeues every job a previous process left running, then polls every `pollMs`. */
  start(): void;
  /** No new jobs; resolves when the running ones settled. */
  stop(): Promise<void>;
  /** One loop pass: requeue expired leases, enqueue due schedules, close an idle browser, start what fits. */
  tick(): void;
  /** Resolves when every job started so far has settled (tests). */
  settle(): Promise<void>;
  list(state?: JobState, limit?: number): Job[];
}

export const DEFAULT_LEASE_MS = 10 * 60_000;
export const AGENT_BROWSER_IDLE_MS = Number(process.env.AGENT_BROWSER_IDLE_MS ?? 3 * 60_000);
const PRUNE_EVERY_MS = 3600_000;
const KEEP_FINISHED_MS = 7 * 86_400_000;

/** Retry delay after the n-th failed attempt: 30 s, 1 min, 2 min … capped at 30 min. */
export const backoffMs = (attempt: number): number => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);

const alertKey = (kind: string) => `alert_open:job:${kind}`;

const consoleLog: Logger = {
  info: (stage, m) => console.error(`[agent] [${stage}] ${m}`),
  warn: (stage, m) => console.error(`[agent] WARN [${stage}] ${m}`),
  error: (stage, m) => console.error(`[agent] ERROR [${stage}] ${m}`),
};

export function createAgent(o: AgentOptions): Agent {
  const { store, handlers } = o;
  const now = o.now ?? (() => new Date());
  const log = o.log ?? consoleLog;
  const llmSlots = o.llmSlots ?? CLAUDE_PARALLEL;
  const idleMs = o.browserIdleMs ?? AGENT_BROWSER_IDLE_MS;
  const running = new Map<number, Resource>();
  const inflight = new Set<Promise<void>>();
  const nextAt = new Map<Schedule, number>();
  let browserUsedAt = 0; // end of the last browser job while the browser may be open; 0 = closed
  let lastPrune = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const enqueue: Agent["enqueue"] = (kind, payload = {}, opts = {}) => store.enqueueJob(kind, payload, opts, now().toISOString());
  const ctx: JobContext = { now, enqueue, log };
  const count = (r: Resource) => [...running.values()].filter((x) => x === r).length;

  const fits = (r: Resource) => (r === "browser" ? count("browser") < 1 : r === "llm" ? count("llm") < llmSlots : true);

  async function execute(job: Job, h: JobHandler): Promise<void> {
    const leaseMs = h.leaseMs ?? DEFAULT_LEASE_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        h.run(job, ctx),
        new Promise<never>((_, reject) => (timeout = setTimeout(() => reject(new Error(`timeout: ran longer than ${Math.round(leaseMs / 1000)} s`)), leaseMs))),
      ]);
      store.finishJob(job.id, now().toISOString());
      if (store.getSetting(alertKey(job.kind))) store.setSetting(alertKey(job.kind), "");
    } catch (e) {
      const error = errMessage(e);
      // A hung page keeps its Chrome busy: close it, the next browser job opens a fresh one.
      // ponytail: the wedged handler promise is abandoned, not cancelled; handlers are idempotent.
      if (h.needs === "browser" && error.startsWith("timeout:")) await o.browser?.close().catch(() => undefined);
      const at = now();
      const state = store.failJob(job.id, error, new Date(at.getTime() + backoffMs(job.attempts)).toISOString(), at.toISOString());
      log.warn(job.kind, `job #${job.id} attempt ${job.attempts}/${job.maxAttempts} failed: ${error}`);
      if (state === "failed") {
        // Once per kind until a job of that kind succeeds again (like scheduler/health.ts alerts).
        if (!store.getSetting(alertKey(job.kind))) {
          store.setSetting(alertKey(job.kind), at.toISOString());
          await o.notifier.alert(`Агент: задача ${job.kind} не выполнена`, `${job.attempts} попыток, последняя ошибка: ${error}`).catch(() => undefined);
        }
        await Promise.resolve(h.onFailed?.(job, error)).catch((fe: unknown) => log.error(job.kind, `onFailed: ${errMessage(fe)}`));
      }
    } finally {
      clearTimeout(timeout);
      running.delete(job.id);
      if (h.needs === "browser") browserUsedAt = now().getTime();
    }
  }

  function tick(): void {
    if (stopped) return;
    const t = now();
    const iso = t.toISOString();
    const lost = store.requeueExpired(iso, [...running.keys()]);
    if (lost) log.warn("queue", `${lost} job(s) with an expired lease requeued`);
    for (const s of o.schedules ?? []) {
      if (t.getTime() < (nextAt.get(s) ?? 0)) continue;
      nextAt.set(s, t.getTime() + s.everyMs);
      enqueue(s.kind, s.payload ?? {}, { key: s.key ?? s.kind });
    }
    if (t.getTime() - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = t.getTime();
      store.pruneJobs(new Date(t.getTime() - KEEP_FINISHED_MS).toISOString());
    }
    if (o.browser && browserUsedAt && !count("browser") && t.getTime() - browserUsedAt >= idleMs) {
      browserUsedAt = 0;
      void o.browser.close().catch(() => undefined);
    }
    for (const due of store.dueJobs(iso, 50)) {
      const h = handlers[due.kind];
      if (!h) {
        // An unknown kind (renamed or removed handler) would sit in the queue forever.
        if (store.claimJob(due.id, iso, iso)) store.failJob(due.id, `no handler for ${due.kind}`, iso, iso, true);
        continue;
      }
      if (!fits(h.needs)) continue;
      if (!store.claimJob(due.id, new Date(t.getTime() + (h.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(), iso)) continue;
      const job = { ...due, attempts: due.attempts + 1, state: "running" as const };
      running.set(job.id, h.needs);
      if (h.needs === "browser") browserUsedAt = t.getTime();
      const p = execute(job, h);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
  }

  return {
    enqueue,
    start() {
      stopped = false;
      // Single process: whatever is still "running" at boot died with the previous one.
      const n = store.requeueExpired("9999", []);
      if (n) log.warn("queue", `boot: ${n} interrupted job(s) requeued`);
      timer = setInterval(tick, o.pollMs ?? 2000);
      tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([...inflight]);
      await o.browser?.close().catch(() => undefined);
    },
    tick,
    async settle() {
      while (inflight.size) await Promise.all([...inflight]);
    },
    list: (state, limit = 100) => store.listJobs(state, limit),
  };
}
