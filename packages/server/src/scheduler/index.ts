// Daily trigger: fires `at` (HH:MM in tz) ± a deterministic per-day jitter and starts a full run.
import { RunBusyError, type RunService } from "@sgz/shared";
import { errMessage } from "../runner/util.js";
import { addDays, zonedParts, zonedToUtc } from "./tz.js";

export interface SchedulerOptions {
  at: string; // "HH:MM"
  tz: string;
  jitterMin: number;
  now?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  log?: (msg: string) => void;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Apply panel changes immediately; an active timer is rescheduled. */
  configure(next: Partial<Pick<SchedulerOptions, "at" | "tz" | "jitterMin">>): void;
  next(): Date;
  running(): boolean;
}

const MAX_TIMEOUT = 2 ** 31 - 1;

/** FNV-1a over the day string → uniform [0,1). Same day → same jitter across restarts. */
function dayJitterFraction(dayKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < dayKey.length; i++) {
    h ^= dayKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

export function createScheduler(svc: RunService, opts: SchedulerOptions): Scheduler {
  const now = opts.now ?? (() => new Date());
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const log = opts.log ?? ((m: string) => console.error(m));
  let at = opts.at.trim();
  let tz = opts.tz;
  let jitterMin = Math.max(0, opts.jitterMin);
  const parseTime = (value: string): { hour: number; minute: number } => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`scheduler: bad time "${value}", expected HH:MM`);
    return { hour: Number(m[1]), minute: Number(m[2]) };
  };
  parseTime(at);

  const fireAt = (day: { y: number; m: number; d: number }): Date => {
    const { hour, minute } = parseTime(at);
    const base = zonedToUtc(day.y, day.m, day.d, hour, minute, tz);
    const key = `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
    const jitter = Math.round((dayJitterFraction(key) * 2 - 1) * jitterMin * 60_000);
    return new Date(base.getTime() + jitter);
  };

  const nextAfter = (t: Date): Date => {
    const today = zonedParts(t, tz);
    for (let i = -1; i <= 2; i++) {
      const candidate = fireAt(addDays(today, i));
      if (candidate.getTime() > t.getTime()) return candidate;
    }
    return fireAt(addDays(today, 1));
  };

  let timer: unknown = null;
  let running = false;
  let floor = 0; // never fire twice for the same slot

  const schedule = () => {
    if (!running) return;
    const t = now();
    const target = nextAfter(new Date(Math.max(t.getTime(), floor)));
    const delay = Math.max(0, target.getTime() - t.getTime());
    timer = setT(() => {
      timer = null;
      if (!running) return;
      if (now().getTime() < target.getTime() - 1000) return schedule(); // capped timeout: keep waiting
      floor = target.getTime() + 60_000;
      void fire().then((busy) => (busy ? retry() : schedule()));
    }, Math.min(delay, MAX_TIMEOUT));
  };

  // The autopilot keeps the runner busy most of the day: a busy slot waits for it instead of losing the day's run.
  const retry = () => {
    if (!running) return;
    timer = setT(() => {
      timer = null;
      if (running) void fire().then((busy) => (busy ? retry() : schedule()));
    }, 60_000);
  };

  /** True when the runner was busy and the slot is still owed. */
  const fire = async (): Promise<boolean> => {
    try {
      const id = await svc.start({ userSlug: "all", source: "all", dryRun: false, limit: 0, trigger: "schedule" });
      log(`scheduler: started run #${id}`);
    } catch (e) {
      if (e instanceof RunBusyError) {
        log("scheduler: a run is already active, retrying in a minute");
        return true;
      }
      log(`scheduler: start failed: ${errMessage(e)}`);
    }
    return false;
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
      log(`scheduler: next run at ${nextAfter(now()).toISOString()} (${at} ${tz} ±${jitterMin}m)`);
    },
    stop() {
      running = false;
      if (timer !== null) clearT(timer);
      timer = null;
    },
    configure(next) {
      if (next.at !== undefined) parseTime(next.at);
      if (next.tz !== undefined) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: next.tz }).format();
        } catch {
          throw new Error(`scheduler: invalid timezone "${next.tz}"`);
        }
      }
      if (next.jitterMin !== undefined && (!Number.isFinite(next.jitterMin) || next.jitterMin < 0)) throw new Error("scheduler: jitter must be non-negative");
      at = next.at?.trim() ?? at;
      tz = next.tz ?? tz;
      jitterMin = next.jitterMin ?? jitterMin;
      floor = 0;
      if (running) {
        if (timer !== null) clearT(timer);
        timer = null;
        schedule();
        log(`scheduler: reconfigured (${at} ${tz} ±${jitterMin}m), next run at ${nextAfter(now()).toISOString()}`);
      }
    },
    next: () => nextAfter(new Date(Math.max(now().getTime(), floor))),
    running: () => running,
  };
}
