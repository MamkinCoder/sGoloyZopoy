import { describe, expect, it, vi } from "vitest";
import { createScheduler } from "./index.js";
import type { RunService } from "@sgz/shared";

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
});
