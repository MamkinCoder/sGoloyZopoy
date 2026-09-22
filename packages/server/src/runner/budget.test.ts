import { describe, expect, it, vi } from "vitest";
import { dailyBudget, guardMemory } from "./budget.js";
import { RunAbortError, Status, type Store, type User } from "@sgz/shared";

const user = { id: 7 } as User;

describe("runner budgets and memory guard", () => {
  it("caps requested work by sent applications across all requested sources", () => {
    const store = { countSentToday: vi.fn((_id: number, source: string) => source === "hh" ? 2 : 1) } as unknown as Store;
    expect(dailyBudget(store, user, ["hh", "acme"], 5, 99, "2026-01-01")).toBe(2);
    expect(dailyBudget(store, user, ["hh"], 5, 1, "2026-01-01")).toBe(1);
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
