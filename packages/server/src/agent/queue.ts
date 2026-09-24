// The always-on agent (docs/ARCHITECTURE.md §2): a persistent job queue worked by one loop inside `sgz serve`.
// Handlers are the unit of extension: a new always-on feature is a new job kind, not a new timer.
// Resources: at most one browser job (one agent Chrome), at most `llmSlots` LLM jobs, `none` jobs freely.
import type { EnqueueOptions, Job, JobState, Logger, Notifier, Store } from "@sgz/shared";
import type { JobsRepo } from "../db/jobs.js";
import { CLAUDE_PARALLEL, llmCaller } from "../llm/mutex.js";
import { alertOnce, closeAlert } from "../notify/alert.js";
import { errMessage } from "../runner/util.js";

export type Resource = "browser" | "llm" | "none";

export interface JobContext {
  now(): Date;
  enqueue: Agent["enqueue"];
  log: Logger;
  /** Aborted when the job times out; `claude` calls made by the job are killed with it (llmCaller). */
  signal: AbortSignal;
}

export interface JobHandler {
  needs: Resource;
  /** Idempotent: reads its state from the DB. A throw retries with backoff until max attempts. */
  run(job: Job, ctx: JobContext): Promise<void>;
  /** Longest run before the job counts as hung (timeout = failed attempt) and its lease as expired. Default 10 min.
   *  An `llm` job's clock starts when it gets its first claude slot (batch runs may hold both for a while). */
  leaseMs?: number;
  /** Once, when the job exhausted its attempts. With it the handler alerts itself (per task, naming the employer);
   *  without it the queue alerts once per kind until a job of that kind succeeds again. */
  onFailed?(job: Job, error: string): void | Promise<void>;
}

/** A recurring job: checked every `everyMs` (the first time right at start) and enqueued by key. No due work, no job. */
export interface Schedule {
  kind: string;
  everyMs: number;
  payload?: Record<string, unknown>;
  /** Default: the kind. */
  key?: string;
  /** Cheap check: enqueue only when it returns true (default: always). The handler re-checks what it needs. */
  due?(now: Date): boolean;
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
  /** No browser job starts while less memory is free (the runner's Chrome and claude share the Pi). */
  memAvailableMB?: () => number;
  memoryGuardMB?: number;
  llmSlots?: number;
  /** Leave jobs without a handler queued instead of failing them (SGZ_RUNNER=false: the chat kinds wait for a
   *  process that runs them). */
  keepUnknown?: boolean;
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
  const ctx = { now, enqueue, log };
  const count = (r: Resource) => [...running.values()].filter((x) => x === r).length;

  const memOk = () => !o.memAvailableMB || o.memAvailableMB() >= (o.memoryGuardMB ?? 0);
  const fits = (r: Resource) => (r === "browser" ? count("browser") < 1 && memOk() : r === "llm" ? count("llm") < llmSlots : true);

  /** Out of attempts: the handler's onFailed (it alerts per task), else one alert per kind. */
  async function finalFailure(job: Job, h: JobHandler, error: string): Promise<void> {
    if (h.onFailed) {
      await Promise.resolve(h.onFailed(job, error)).catch((fe: unknown) => log.error(job.kind, `onFailed: ${errMessage(fe)}`));
      return;
    }
    // Once per kind until a job of that kind succeeds again.
    await alertOnce(store, o.notifier, alertKey(job.kind), { now: now(), title: `Агент: задача ${job.kind} не выполнена`, body: `${job.attempts} попыток, последняя ошибка: ${error}` }).catch(() => undefined);
  }

  async function execute(job: Job, h: JobHandler): Promise<void> {
    const leaseMs = h.leaseMs ?? DEFAULT_LEASE_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const ac = new AbortController();
    let expire: (e: Error) => void = () => undefined;
    const expired = new Promise<never>((_, reject) => (expire = reject));
    const startClock = () => {
      if (timeout === undefined && !settled) timeout = setTimeout(() => expire(new Error(`timeout: ran longer than ${Math.round(leaseMs / 1000)} s`)), leaseMs);
    };
    // The resource stays taken until the handler really returns, even past a timeout: a wedged chats.sync must
    // not share the agent Chrome with the next browser job. ponytail: not cancelled; closing the browser below
    // makes a hung page call throw, a handler stuck elsewhere keeps its slot until it returns.
    const release = () => {
      running.delete(job.id);
      if (h.needs === "browser") browserUsedAt = now().getTime();
    };
    // ponytail: an llm job that hangs before any claude call has no clock; every llm handler calls claude first.
    if (h.needs !== "llm") startClock();
    const jobCtx: JobContext = { ...ctx, signal: ac.signal };
    const call = async () => h.run(job, jobCtx);
    // Agent jobs wait ahead of batch runs for a claude slot. `none` jobs run plain: the autopilot's runner.start
    // must not hand the whole batch run the agent's priority.
    const runP = (h.needs === "none" ? call() : llmCaller.run({ priority: true, signal: ac.signal, onAcquire: startClock }, call)).finally(() => (settled = true));
    try {
      await Promise.race([runP, expired]);
      store.finishJob(job.id, now().toISOString());
      await closeAlert(store, alertKey(job.kind));
    } catch (e) {
      const error = errMessage(e);
      if (error.startsWith("timeout:")) ac.abort(); // kills its claude child
      // A hung page keeps its Chrome busy: close it, the next browser job opens a fresh one.
      if (h.needs === "browser" && error.startsWith("timeout:")) await o.browser?.close().catch(() => undefined);
      const at = now();
      const state = store.failJob(job.id, error, new Date(at.getTime() + backoffMs(job.attempts)).toISOString(), at.toISOString());
      log.warn(job.kind, `job #${job.id} attempt ${job.attempts}/${job.maxAttempts} failed: ${error}`);
      if (state === "failed") await finalFailure(job, h, error);
    } finally {
      clearTimeout(timeout);
      if (settled) release();
      else void runP.then(release, release);
    }
  }

  function tick(): void {
    if (stopped) return;
    try {
      pass();
    } catch (e) {
      // A DB error (SQLITE_BUSY while a CLI holds the lock) must not kill `sgz serve`: the next tick retries.
      log.error("queue", errMessage(e));
    }
  }

  function pass(): void {
    const t = now();
    const iso = t.toISOString();
    const lost = store.requeueExpired(iso, [...running.keys()]);
    if (lost) log.warn("queue", `${lost} job(s) with an expired lease requeued`);
    for (const s of o.schedules ?? []) {
      if (t.getTime() < (nextAt.get(s) ?? 0)) continue;
      nextAt.set(s, t.getTime() + s.everyMs);
      try {
        if (s.due && !s.due(t)) continue;
      } catch (e) {
        log.error(s.kind, `due: ${errMessage(e)}`);
        continue;
      }
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
        if (o.keepUnknown) continue;
        // An unknown kind (renamed or removed handler) would sit in the queue forever.
        if (store.claimJob(due.id, iso, iso)) store.failJob(due.id, `no handler for ${due.kind}`, iso, iso, true);
        continue;
      }
      if (running.has(due.id) || !fits(h.needs)) continue; // its timed-out previous attempt still runs
      if (due.attempts >= due.maxAttempts) {
        // Out of attempts but queued again: its run died with the process (OOM kill, crash) every time. Fail it
        // instead of running it again after every restart.
        if (store.claimJob(due.id, iso, iso)) {
          store.failJob(due.id, due.lastError || "interrupted", iso, iso, true);
          const job = { ...due, attempts: due.attempts + 1 };
          log.warn(due.kind, `job #${due.id} failed: ${due.attempts} attempts interrupted`);
          const p = finalFailure(job, h, `${due.attempts} попыток прервано перезапуском (${due.lastError || "interrupted"})`).catch((e: unknown) => log.error(due.kind, errMessage(e)));
          inflight.add(p);
          void p.finally(() => inflight.delete(p));
        }
        continue;
      }
      if (!store.claimJob(due.id, new Date(t.getTime() + (h.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(), iso)) continue;
      const job = { ...due, attempts: due.attempts + 1, state: "running" as const };
      running.set(job.id, h.needs);
      if (h.needs === "browser") browserUsedAt = t.getTime();
      const p = execute(job, h).catch((e: unknown) => log.error(job.kind, `job #${job.id}: ${errMessage(e)}`));
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
