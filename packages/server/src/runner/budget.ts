// Throttle, memory guard and daily budget: the three things that keep the Pi and hh.ru happy.
import { readFileSync } from "node:fs";
import { RunAbortError, Status, type Config, type Logger, type Store, type User } from "@sgz/shared";
import { addDays, zonedParts, zonedToUtc } from "../scheduler/tz.js";

export function readMemAvailableMB(): number {
  if (process.platform !== "linux") return 4096;
  try {
    const m = /MemAvailable:\s+(\d+)\s*kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    return m ? Math.floor(Number(m[1]) / 1024) : 4096;
  } catch {
    return 4096;
  }
}

export interface Throttle {
  /** Random cfg.throttleMinMs..throttleMaxMs after apply / send. */
  afterMutation(): Promise<void>;
  /** 2-5 s after page reads. */
  afterRead(): Promise<void>;
}

export function createThrottle(cfg: Config, sleep: (ms: number, signal?: AbortSignal) => Promise<void>, random: () => number, signal: AbortSignal): Throttle {
  const between = (min: number, max: number) => Math.round(min + random() * Math.max(0, max - min));
  return {
    afterMutation: () => sleep(between(cfg.throttleMinMs, cfg.throttleMaxMs), signal),
    afterRead: () => sleep(between(2000, 5000), signal),
  };
}

export interface MemoryGuardOpts {
  cfg: Config;
  memAvailableMB: () => number;
  sleep: (ms: number) => Promise<void>;
  closeBrowser: () => Promise<void>;
  log: Logger;
}

/** Before LLM batches / xelatex: free the browser if memory is tight; abort the run if it stays tight. */
export async function guardMemory(stage: string, o: MemoryGuardOpts): Promise<void> {
  const first = o.memAvailableMB();
  if (first >= o.cfg.memoryGuardMB) return;
  o.log.warn(stage, `low memory: ${first} MB available (< ${o.cfg.memoryGuardMB}), closing browser`, { mem_mb: first });
  await o.closeBrowser();
  await o.sleep(2000);
  const second = o.memAvailableMB();
  if (second >= o.cfg.memoryGuardMB) return;
  throw new RunAbortError(Status.FAILED_LOW_MEMORY, `only ${second} MB available after closing the browser (need ${o.cfg.memoryGuardMB})`);
}

/** UTC bounds [since, until) of `now`'s local day in tz. */
export function dayBoundsUtc(now: Date, tz: string): { since: string; until: string } {
  const p = zonedParts(now, tz);
  const next = addDays(p, 1);
  return { since: zonedToUtc(p.y, p.m, p.d, 0, 0, tz).toISOString(), until: zonedToUtc(next.y, next.m, next.d, 0, 0, tz).toISOString() };
}

/** min(daily limit − sent during now's local day, req.limit || ∞); never negative. */
export function dailyBudget(store: Store, user: User, sources: string[], dailyLimit: number, reqLimit: number, now: Date, tz: string): number {
  const { since, until } = dayBoundsUtc(now, tz);
  let sentToday = 0;
  for (const s of sources) sentToday += store.countSentToday(user.id, s, since, until);
  const remaining = Math.max(0, dailyLimit - sentToday);
  return reqLimit > 0 ? Math.min(remaining, reqLimit) : remaining;
}
