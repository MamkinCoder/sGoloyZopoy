import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunBusyError, type BrowserLauncher, type Config, type Notifier, type RunRequest, type User } from "@sgz/shared";
import { openStore, type SqliteStore } from "../db/index.js";
import type { RunContext } from "./context.js";
import type { RunnerDeps } from "./deps.js";

// The pipeline and the report are replaced per test.
type Result = { status: string; error: string; users: [] };
const never = () => new Promise<never>(() => undefined);
const done = async (): Promise<Result> => ({ status: "done", error: "", users: [] });
/** Resolves only on abort (a pipeline that honours stop / the watchdog). */
const cooperative = (ctx: RunContext) => new Promise<Result>((resolve) => ctx.signal.addEventListener("abort", () => resolve({ status: "stopped", error: "stopped by request", users: [] })));
let pipeline: (ctx: RunContext) => Promise<Result>;
let reports: () => Promise<boolean>;
vi.mock("./pipeline.js", () => ({
  runPipeline: (ctx: RunContext) => pipeline(ctx),
  aggregate: () => ({ by_status: {} }),
  sendReports: () => reports(),
}));
const { createRunner, maxRunMs, repeatFailure, WATCHDOG_GRACE_MS } = await import("./service.js");

let store: SqliteStore;
let alerts: string[];
let launches: string[];
let launchDelayMs: number;
const notifier: Notifier = { report: async () => undefined, alert: async (title) => void alerts.push(title) };
// Every browser this fake launches is wedged: close() never settles.
const launcher: BrowserLauncher = {
  launch: async (o) => {
    launches.push(o.userDataDir);
    if (launchDelayMs) await new Promise((r) => setTimeout(r, launchDelayMs));
    return { close: never } as never;
  },
};
const user = { slug: "u" } as User;

beforeEach(() => {
  vi.useFakeTimers();
  store = openStore(":memory:");
  alerts = [];
  launches = [];
  launchDelayMs = 0;
  pipeline = cooperative;
  reports = async () => false;
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
});

const runner = () => createRunner({ cfg: { dataDir: "/d" } as Config, store, notifier, launcher, llm: { withRun: () => ({}) }, stderr: () => undefined } as unknown as RunnerDeps);
const req = (stage?: string, trigger: "schedule" | "manual" = "schedule"): RunRequest => ({ userSlug: "all", source: "all", stage, trigger, dryRun: false, limit: 0 });

describe("run watchdog", () => {
  it("picks caps per stage and honours the override", () => {
    expect(maxRunMs({ stage: "touch" }, null)).toBe(20 * 60_000);
    expect(maxRunMs({ stage: "send:7" }, "0")).toBe(30 * 60_000);
    expect(maxRunMs({}, "")).toBe(150 * 60_000);
    expect(maxRunMs({ stage: "touch" }, "45")).toBe(45 * 60_000);
  });

  it.each([
    ["cooperative", 0, "stopped"],
    ["wedged", WATCHDOG_GRACE_MS, "failed"],
  ] as const)("ends a %s run past its limit", async (m, extra, status) => {
    pipeline = m === "cooperative" ? cooperative : never;
    const r = runner();
    const id = await r.start(req("touch"));
    await vi.advanceTimersByTimeAsync(20 * 60_000 + extra);
    const run = await r.wait(id);
    expect(run).toMatchObject({ status, error: "watchdog: exceeded 20 min" });
    expect(store.getRun(id)?.status).toBe(status);
    expect(r.active()).toBeNull();
    expect(alerts).toEqual([`Прогон #${id} остановлен сторожем`]);
  });

  // Production: the browser came up after the watchdog's close (a slow launch), the pipeline stayed wedged,
  // and the runner awaited close() of that wedged Chrome forever, so active() kept the run.
  it("frees the slot when the pipeline never settles and browser.close hangs", async () => {
    launchDelayMs = 150 * 60_000 + 1000;
    pipeline = async (ctx) => {
      await ctx.browser.open(user);
      return never();
    };
    const r = runner();
    const id = await r.start(req(undefined));
    await vi.advanceTimersByTimeAsync(150 * 60_000 + WATCHDOG_GRACE_MS + 60_000);
    expect(r.active()).toBeNull();
    expect(store.getRun(id)).toMatchObject({ status: "failed", error: "watchdog: exceeded 150 min" });
    expect(await r.start(req(undefined))).toBeGreaterThan(id);
  });

  it("frees the slot when the report hangs after the pipeline gave up", async () => {
    reports = never;
    const r = runner();
    const id = await r.start(req(undefined, "manual"));
    await vi.advanceTimersByTimeAsync(150 * 60_000 + WATCHDOG_GRACE_MS);
    expect(r.active()).toBeNull();
    expect(store.getRun(id)).toMatchObject({ status: "stopped", error: "watchdog: exceeded 150 min" });
  });
});

describe("one run at a time", () => {
  it("refuses a second run while one is active; runs use the main Chrome profile", async () => {
    const r = runner();
    const main = await r.start(req(undefined));
    await expect(r.start(req("touch"))).rejects.toBeInstanceOf(RunBusyError);
    await r.stop(main);
    await r.drain();
    expect(r.active()).toBeNull();
    pipeline = async (ctx) => {
      await ctx.browser.open(user);
      return done();
    };
    await r.wait(await r.start(req(undefined)));
    expect(launches).toEqual(["/d/users/u/chrome-profile"]);
  });
});

describe("repeatFailure", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string) => void m.set(k, v) };
  };
  const req = (stage: string, trigger: "schedule" | "manual" = "schedule") => ({ userSlug: "all", source: "hh", stage, dryRun: false, limit: 0, trigger }) as RunRequest;
  const t0 = new Date("2026-09-23T10:00:00Z");

  it("reports a background failure once per 3h, ignoring digits; manual runs always", () => {
    const s = store();
    expect(repeatFailure(s, req("touch"), "run #51: login expired", t0)).toBe(false);
    expect(repeatFailure(s, req("touch"), "run #52: login expired", new Date(t0.getTime() + 5 * 60_000))).toBe(true);
    expect(repeatFailure(s, req("touch"), "run #53: login expired", new Date(t0.getTime() + 3 * 3600_000 + 1))).toBe(false);
    expect(repeatFailure(s, req("touch", "manual"), "run #54: login expired", t0)).toBe(false);
    expect(repeatFailure(s, req("send:5"), "boom", t0)).toBe(false);
    expect(repeatFailure(s, req("send:5"), "boom", t0)).toBe(false);
  });
});
