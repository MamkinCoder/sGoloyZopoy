import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Notifier, RunRequest } from "@sgz/shared";
import { openStore, type SqliteStore } from "../db/index.js";
import type { RunnerDeps } from "./deps.js";

// The pipeline is replaced per test: `hang` resolves only on abort (cooperative) or never (wedged).
let mode: "cooperative" | "wedged" = "cooperative";
vi.mock("./pipeline.js", () => ({
  runPipeline: (ctx: { signal: AbortSignal }) =>
    new Promise((resolve) => {
      if (mode === "cooperative") ctx.signal.addEventListener("abort", () => resolve({ status: "stopped", error: "stopped by request", users: [] }));
    }),
  aggregate: () => ({ by_status: {} }),
  sendReports: async () => false,
}));
const { createRunner, maxRunMs, repeatFailure, WATCHDOG_GRACE_MS } = await import("./service.js");

let store: SqliteStore;
let alerts: string[];
const notifier: Notifier = { report: async () => undefined, alert: async (title) => void alerts.push(title) };

beforeEach(() => {
  vi.useFakeTimers();
  store = openStore(":memory:");
  alerts = [];
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
});

const runner = () => createRunner({ cfg: {} as Config, store, notifier, llm: { withRun: () => ({}) }, stderr: () => undefined } as unknown as RunnerDeps);

describe("run watchdog", () => {
  it("picks caps per stage and honours the override", () => {
    expect(maxRunMs({ stage: "chats" }, null)).toBe(20 * 60_000);
    expect(maxRunMs({ stage: "send:7" }, "0")).toBe(30 * 60_000);
    expect(maxRunMs({}, "")).toBe(150 * 60_000);
    expect(maxRunMs({ stage: "chats" }, "45")).toBe(45 * 60_000);
  });

  it.each([
    ["cooperative", 0, "stopped"],
    ["wedged", WATCHDOG_GRACE_MS, "failed"],
  ] as const)("ends a %s run past its limit", async (m, extra, status) => {
    mode = m;
    const r = runner();
    const id = await r.start({ userSlug: "all", source: "hh", stage: "chats", trigger: "schedule", dryRun: false, limit: 0 });
    await vi.advanceTimersByTimeAsync(20 * 60_000 + extra);
    const run = await r.wait(id);
    expect(run).toMatchObject({ status, error: "watchdog: exceeded 20 min" });
    expect(store.getRun(id)?.status).toBe(status);
    expect(r.active()).toBeNull();
    expect(alerts).toEqual([`Прогон #${id} остановлен сторожем`]);
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
    expect(repeatFailure(s, req("chats"), "run #51: login expired", t0)).toBe(false);
    expect(repeatFailure(s, req("chats"), "run #52: login expired", new Date(t0.getTime() + 5 * 60_000))).toBe(true);
    expect(repeatFailure(s, req("chats"), "run #53: login expired", new Date(t0.getTime() + 3 * 3600_000 + 1))).toBe(false);
    expect(repeatFailure(s, req("chats", "manual"), "run #54: login expired", t0)).toBe(false);
    expect(repeatFailure(s, req("send:5"), "boom", t0)).toBe(false);
    expect(repeatFailure(s, req("send:5"), "boom", t0)).toBe(false);
  });
});
