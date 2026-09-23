import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyRunStats, type Notifier } from "@sgz/shared";
import { openStore, type SqliteStore } from "../db/index.js";
import { checkHeartbeat } from "./health.js";

let store: SqliteStore;
let alerts: string[];
const notifier: Notifier = { report: async () => undefined, alert: async (title) => void alerts.push(title) };
const H = 3600_000;
const t0 = new Date("2026-09-01T00:00:00.000Z");
const at = (h: number) => new Date(t0.getTime() + h * H);

beforeEach(() => {
  store = openStore(":memory:");
  alerts = [];
});
afterEach(() => store.close());

describe("checkHeartbeat", () => {
  it("alerts once when stale, once on recovery", async () => {
    const check = (h: number) => checkHeartbeat(store, notifier, t0, "UTC", at(h));
    await check(25); // fresh install: boot is the baseline
    expect(alerts).toEqual([]);
    await check(27);
    await check(28);
    expect(alerts).toEqual(["Нет успешных прогонов"]);
    const r = store.insertRun({ userId: null, source: "hh", trigger: "schedule", status: "running", stats: emptyRunStats(), tgSent: false, error: "" });
    store.finishRun({ ...r, status: "done", finishedAt: at(29).toISOString() });
    await check(29.5);
    await check(30);
    expect(alerts).toEqual(["Нет успешных прогонов", "✅ Прогоны снова в норме"]);
    await check(29 + 27);
    expect(alerts).toHaveLength(3);
  });
});
