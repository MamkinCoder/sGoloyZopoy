// Action cache: observe() results (selector + method + args) keyed by host and instruction,
// persisted as one JSON file per host. A replay that fails twice in a row drops the entry.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CachedAction {
  selector: string;
  method: string;
  arguments: string[];
  description: string;
}

export interface CacheEntry extends CachedAction {
  hits: number;
  lastOkAt: string; // ISO
  failures: number; // consecutive replay failures
}

export type HostCache = Record<string, CacheEntry>;

export const MAX_FAILURES = 2;

export const cacheKeyFor = (instruction: string, cacheKey?: string): string => cacheKey ?? instruction;

export const hostOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.host || u.protocol.replace(":", "") || "local";
  } catch {
    return "local";
  }
};

export const cacheFile = (dir: string, host: string): string =>
  join(dir, `${host.replace(/[^a-z0-9.-]/gi, "_") || "local"}.json`);

export function readHostCache(dir: string, host: string): HostCache {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(dir, host), "utf8")) as unknown;
    return isRecord(raw) ? (raw as HostCache) : {};
  } catch {
    return {};
  }
}

/** tmp + rename so a crash mid-write never leaves a truncated file. */
export function writeHostCache(dir: string, host: string, cache: HostCache): void {
  mkdirSync(dir, { recursive: true });
  const file = cacheFile(dir, host);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, file);
}

export function recordSuccess(cache: HostCache, key: string, action: CachedAction, now = new Date()): HostCache {
  const prev = cache[key];
  const same = prev && prev.selector === action.selector && prev.method === action.method;
  return {
    ...cache,
    [key]: {
      selector: action.selector,
      method: action.method,
      arguments: [...action.arguments],
      description: action.description,
      hits: same ? prev.hits + 1 : 1,
      lastOkAt: now.toISOString(),
      failures: 0,
    },
  };
}

/** Counts a replay failure; the entry is removed once MAX_FAILURES is reached. */
export function recordFailure(cache: HostCache, key: string): HostCache {
  const prev = cache[key];
  if (!prev) return cache;
  const failures = prev.failures + 1;
  if (failures >= MAX_FAILURES) {
    const { [key]: _dropped, ...rest } = cache;
    return rest;
  }
  return { ...cache, [key]: { ...prev, failures } };
}

export function invalidate(cache: HostCache, key: string): HostCache {
  if (!(key in cache)) return cache;
  const { [key]: _dropped, ...rest } = cache;
  return rest;
}

/** In-memory per-host cache with write-through to `dir` (memory-only when dir is undefined). */
export class ActionCache {
  private readonly hosts = new Map<string, HostCache>();

  constructor(private readonly dir?: string) {}

  private load(host: string): HostCache {
    let c = this.hosts.get(host);
    if (!c) {
      c = this.dir ? readHostCache(this.dir, host) : {};
      this.hosts.set(host, c);
    }
    return c;
  }

  private store(host: string, cache: HostCache): void {
    this.hosts.set(host, cache);
    if (this.dir) {
      try {
        writeHostCache(this.dir, host, cache);
      } catch {
        // a cache write failure must never break an action
      }
    }
  }

  get(host: string, key: string): CacheEntry | undefined {
    return this.load(host)[key];
  }

  success(host: string, key: string, action: CachedAction): void {
    this.store(host, recordSuccess(this.load(host), key, action));
  }

  failure(host: string, key: string): void {
    this.store(host, recordFailure(this.load(host), key));
  }

  invalidate(host: string, key: string): void {
    this.store(host, invalidate(this.load(host), key));
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
