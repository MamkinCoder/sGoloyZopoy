import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMClient, Notifier, Run } from "@sgz/shared";
import { createAgent } from "../agent/queue.js";
import { openStore, seedDefaultUsers, type SqliteStore } from "../db/index.js";
import { serveJobs, type ServeJobsDeps } from "./jobs.js";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let store: SqliteStore;
let clock: number;
let alerts: string[];
const notifier: Notifier = { report: async () => undefined, alert: async (title, body) => void alerts.push(`${title}\n${body}`) };

beforeEach(() => {
  store = openStore(":memory:");
  seedDefaultUsers(store);
  alerts = [];
});
afterEach(() => store.close());

function harness(over: Partial<Omit<ServeJobsDeps, "cfg">> & { cfg?: Partial<ServeJobsDeps["cfg"]> } = {}) {
  const { handlers, schedules } = serveJobs({
    store,
    notifier,
    llm: {} as LLMClient,
    runner: { active: () => ({ id: 1 }) as Run, start: vi.fn(async () => 1) },
    owed: () => false,
    startedAt: new Date(clock),
    chatsPolled: false,
    ...over,
    cfg: { tz: "UTC", panelUrl: "", tgBotToken: "t", runnerEnabled: false, ...over.cfg },
  });
  const agent = createAgent({ store, handlers, schedules, notifier, now: () => new Date(clock), log: silent });
  return async (iso: string) => {
    clock = Date.parse(iso);
    agent.tick();
    await agent.settle();
  };
}
const users = () => store.listUsers(true).length;
const kinds = () => store.listJobs(undefined, 100).map((j) => j.kind);

describe("serve schedules (fake clock)", () => {
  it("digest: once a day at digest_at, no job before it", async () => {
    clock = Date.parse("2026-09-25T19:00:00Z");
    const at = harness();
    await at("2026-09-25T19:59:00Z");
    expect(alerts).toEqual([]);
    expect(kinds()).toEqual([]); // nothing due, no job row
    await at("2026-09-25T20:00:00Z");
    expect(alerts).toHaveLength(users());
    expect(alerts[0]).toMatch(/^Итоги дня · /);
    await at("2026-09-25T20:01:00Z");
    await at("2026-09-25T23:59:00Z");
    expect(alerts).toHaveLength(users());
    expect(store.getSetting("digest_last_day")).toBe("2026-09-25");
    await at("2026-09-26T20:00:00Z");
    expect(alerts).toHaveLength(2 * users());
  });

  it("digest_at \"\" turns it off; the retro runs on retro_day at retro_at once a week", async () => {
    store.setSetting("digest_at", "");
    clock = Date.parse("2026-09-26T18:00:00Z");
    const at = harness();
    await at("2026-09-26T19:00:00Z"); // Saturday
    expect(store.getSetting("retro_last_day")).toBeNull();
    await at("2026-09-27T18:59:00Z"); // Sunday, before retro_at
    expect(store.getSetting("retro_last_day")).toBeNull();
    await at("2026-09-27T19:00:00Z");
    expect(store.getSetting("retro_last_day")).toBe("2026-09-27");
    await at("2026-09-27T19:01:00Z");
    await at("2026-10-01T19:00:00Z");
    expect(kinds()).toEqual(["digest.week"]);
    await at("2026-10-04T19:00:00Z");
    expect(store.getSetting("retro_last_day")).toBe("2026-10-04");
    expect(alerts).toEqual([]); // too small a week sends nothing
  });

  it("interview reminder: once, when due; runner-lane jobs wait while a run is active", async () => {
    clock = Date.parse("2026-09-23T12:00:00Z");
    const u = store.listUsers(true)[0]!;
    const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Acme", state: "invited", lastSeenAt: "" });
    store.setChatInterview(t.id, "2026-09-23T15:30:00.000Z");
    const at = harness({ cfg: { runnerEnabled: true, tgBotToken: "" } });
    await at("2026-09-23T12:00:00Z");
    expect(alerts).toEqual([]); // 3.5 h ahead
    await at("2026-09-23T14:00:00Z");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Через 90 мин собеседование: Acme");
    await at("2026-09-23T14:01:00Z");
    expect(alerts).toHaveLength(1);
    expect(kinds()).toEqual(["interviews.remind"]);
  });

  it("autopilot: an idle runner gets the touch run, touch_last_at only once it started", async () => {
    clock = Date.parse("2026-09-23T12:00:00Z");
    store.setSetting("career_autopilot", "0");
    let active: Run | null = null;
    const start = vi.fn(async () => 7);
    const at = harness({ cfg: { runnerEnabled: true, tgBotToken: "" }, runner: { active: () => active, start } });
    await at("2026-09-23T12:00:00Z");
    expect(start).toHaveBeenCalledWith({ userSlug: "all", source: "hh", stage: "touch", dryRun: false, limit: 0, trigger: "schedule" });
    expect(store.getSetting("touch_last_at")).toBe("2026-09-23T12:00:00.000Z");
    active = { id: 7 } as Run;
    await at("2026-09-23T16:10:00Z"); // touch due again, but the runner is busy
    expect(start).toHaveBeenCalledTimes(1);
    active = null;
    await at("2026-09-23T16:11:00Z");
    expect(start).toHaveBeenCalledTimes(2);
  });
});
