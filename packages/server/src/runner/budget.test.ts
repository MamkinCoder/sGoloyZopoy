import { describe, expect, it, vi } from "vitest";
import { dailyBudget, dayBoundsUtc, guardMemory } from "./budget.js";
import { RunAbortError, Status, type Store, type User } from "@sgz/shared";

const user = { id: 7 } as User;

describe("runner budgets and memory guard", () => {
  it("caps requested work by sent applications across all requested sources", () => {
    const store = { countSentToday: vi.fn((_id: number, source: string) => source === "hh" ? 2 : 1) } as unknown as Store;
    const now = new Date("2026-01-01T12:00:00Z");
    expect(dailyBudget(store, user, ["hh", "acme"], 5, 99, now, "UTC")).toBe(2);
    expect(dailyBudget(store, user, ["hh"], 5, 1, now, "UTC")).toBe(1);
  });

  it("counts the local day, not the UTC date: 00:30 Moscow belongs to the new day", () => {
    expect(dayBoundsUtc(new Date("2026-01-01T21:30:00Z"), "Europe/Moscow")).toEqual({ since: "2026-01-01T21:00:00.000Z", until: "2026-01-02T21:00:00.000Z" });
  });

  it("closes the browser once and aborts if memory remains low", async () => {
    const values = [100, 120];
    const close = vi.fn(async () => undefined);
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    await expect(guardMemory("decide", {
      cfg: { memoryGuardMB: 450 } as never,
      memAvailableMB: () => values.shift() ?? 120,
      sleep: async () => undefined,
      closeBrowser: close,
      log,
    })).rejects.toBeInstanceOf(RunAbortError);
    expect(close).toHaveBeenCalledOnce();
    await expect(guardMemory("decide", {
      cfg: { memoryGuardMB: 450 } as never,
      memAvailableMB: () => 451,
      sleep: async () => undefined,
      closeBrowser: close,
      log,
    })).resolves.toBeUndefined();
    expect(new RunAbortError(Status.FAILED_LOW_MEMORY, "x").status).toBe(Status.FAILED_LOW_MEMORY);
  });
});
