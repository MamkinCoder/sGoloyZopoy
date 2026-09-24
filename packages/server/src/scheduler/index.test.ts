import { describe, expect, it, vi } from "vitest";
import { createScheduler } from "./index.js";
import { RunBusyError, type RunService } from "@sgz/shared";

describe("scheduler", () => {
  it("rejects invalid times and reschedules a live timer on configure", () => {
    const svc = { start: vi.fn(async () => 1) } as unknown as RunService;
    expect(() => createScheduler(svc, { at: "25:00", tz: "UTC", jitterMin: 0 })).toThrow(/bad time/);

    let now = new Date("2026-01-01T11:00:00Z");
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const scheduler = createScheduler(svc, {
      at: "12:00",
      tz: "UTC",
      jitterMin: 0,
      now: () => now,
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (handle) => ((handle as (typeof timers)[number]).cancelled = true),
    });
    scheduler.start();
    expect(timers.at(-1)?.ms).toBe(60 * 60_000);
    scheduler.configure({ at: "13:00" });
    expect(timers[0]?.cancelled).toBe(true);
    expect(timers.at(-1)?.ms).toBe(2 * 60 * 60_000);
    expect(scheduler.next()).toEqual(new Date("2026-01-01T13:00:00Z"));
  });

  it("fires the configured run at the slot", async () => {
    let now = new Date("2026-01-01T11:59:59Z");
    let timer: (() => void) | undefined;
    const start = vi.fn(async () => 9);
    const scheduler = createScheduler({ start } as unknown as RunService, {
      at: "12:00", tz: "UTC", jitterMin: 0, now: () => now,
      setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout: () => undefined,
    });
    scheduler.start();
    now = new Date("2026-01-01T12:00:00Z");
    timer?.();
    await Promise.resolve();
    expect(start).toHaveBeenCalledWith({ userSlug: "all", source: "all", dryRun: false, limit: 0, trigger: "schedule" });
  });

  it("a busy runner at the slot retries every minute instead of dropping the day's run", async () => {
    let now = new Date("2026-01-01T11:59:59Z");
    const timers: { fn: () => void; ms: number }[] = [];
    const start = vi.fn(async () => 9).mockRejectedValueOnce(new RunBusyError()).mockRejectedValueOnce(new RunBusyError());
    const scheduler = createScheduler({ start } as unknown as RunService, {
      at: "12:00", tz: "UTC", jitterMin: 0, now: () => now, log: () => undefined,
      setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: () => undefined,
    });
    scheduler.start();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    now = new Date("2026-01-01T12:00:00Z");
    timers.at(-1)!.fn();
    await flush();
    expect(timers.at(-1)!.ms).toBe(60_000);
    now = new Date("2026-01-01T12:01:00Z");
    timers.at(-1)!.fn();
    await flush();
    expect(timers.at(-1)!.ms).toBe(60_000);
    now = new Date("2026-01-01T12:02:00Z");
    timers.at(-1)!.fn();
    await flush();
    expect(start).toHaveBeenCalledTimes(3);
    expect(scheduler.next()).toEqual(new Date("2026-01-02T12:00:00Z")); // started: back to the daily slot
    expect(timers.at(-1)!.ms).toBe(24 * 3600_000 - 2 * 60_000);
  });

  it("a settings save while the slot is owed keeps retrying today's run; a later slot after firing does not fire twice", async () => {
    let now = new Date("2026-01-01T11:59:59Z");
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const start = vi.fn(async () => 9).mockRejectedValueOnce(new RunBusyError());
    const scheduler = createScheduler({ start } as unknown as RunService, {
      at: "12:00", tz: "UTC", jitterMin: 0, now: () => now, log: () => undefined,
      setTimeout: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
      clearTimeout: (h) => ((h as (typeof timers)[number]).cancelled = true),
    });
    scheduler.start();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    now = new Date("2026-01-01T12:00:00Z");
    timers.at(-1)!.fn();
    await flush();
    expect(scheduler.owed()).toBe(true);
    const retry = timers.at(-1)!;
    now = new Date("2026-01-01T12:00:30Z");
    scheduler.configure({ at: "12:00", tz: "UTC", jitterMin: 0 }); // e.g. career_autopilot toggled in the panel
    expect(retry.cancelled).toBe(false);
    now = new Date("2026-01-01T12:01:00Z");
    retry.fn();
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(scheduler.owed()).toBe(false);
    scheduler.configure({ at: "18:00" }); // moved later the same day after today's run
    expect(scheduler.next()).toEqual(new Date("2026-01-02T18:00:00Z"));
  });
});
