import { describe, expect, it } from "vitest";
import { autoReply, setAutoReply } from "./auto.js";

describe("autoReply", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getSetting: (k: string) => m.get(k) ?? null, setSetting: (k: string, v: string) => void m.set(k, v) };
  };
  it("defaults: hh on, Habr off; per user and per site", () => {
    const s = mem();
    expect([autoReply(s, 1, "hh"), autoReply(s, 1, "habr")]).toEqual([true, false]);
    setAutoReply(s, 1, "hh", false);
    setAutoReply(s, 1, "habr", true);
    expect([autoReply(s, 1, "hh"), autoReply(s, 1, "habr")]).toEqual([false, true]);
    expect([autoReply(s, 2, "hh"), autoReply(s, 2, "habr")]).toEqual([true, false]);
  });
});
