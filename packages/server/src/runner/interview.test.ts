import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatThread, TgButton } from "@sgz/shared";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { askOutcomes, FOLLOW_UP, followupDue, formatPrep, marketLine, parseOutcomeCallback, remindInterviews } from "./interview.js";

const now = new Date("2026-09-23T12:00:00Z");
const thread = (state: ChatThread["state"]): ChatThread => ({ id: 1, userId: 1, hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Acme", state, lastSeenAt: "" });
const msg = (direction: "in" | "out", text: string, answered = true): ChatMessage => ({
  id: 1, threadId: 1, hhMessageId: null, direction, author: direction === "in" ? "employer" : "me", text, isQuestion: false, answered, createdAt: "",
});
const silent = (days: number) => ({ state: "Просмотрено", lastModified: new Date(now.getTime() - days * 86_400_000).toISOString() });

describe("followupDue", () => {
  it("only for a pending thread silent long enough, once", () => {
    expect(followupDue(thread("viewed"), silent(8), [], now, 7)).toBe(true);
    expect(followupDue(thread("new"), silent(8), [msg("in", "Спасибо за отклик, вернёмся")], now, 7)).toBe(true);
    expect(followupDue(thread("viewed"), silent(3), [], now, 7)).toBe(false); // too early
    expect(followupDue(thread("viewed"), silent(8), [], now, 0)).toBe(false); // off
    expect(followupDue(undefined, silent(8), [], now, 7)).toBe(false);
    expect(followupDue(thread("viewed"), { state: "Просмотрено" }, [], now, 7)).toBe(false); // no activity date
  });

  it("never after a rejection, an invitation, a human hand-off or a follow-up already sent", () => {
    expect(followupDue(thread("rejected"), silent(30), [], now, 7)).toBe(false);
    expect(followupDue(thread("invited"), silent(30), [], now, 7)).toBe(false);
    expect(followupDue(thread("needs_human"), silent(30), [], now, 7)).toBe(false);
    expect(followupDue(thread("viewed"), { ...silent(30), state: "Отказ" }, [], now, 7)).toBe(false);
    expect(followupDue(thread("viewed"), silent(30), [msg("out", FOLLOW_UP)], now, 7)).toBe(false);
    expect(followupDue(thread("viewed"), silent(30), [msg("in", "Когда удобно созвониться?", false)], now, 7)).toBe(false); // main loop's job
  });

  it("the follow-up text has no links and no em-dash", () => {
    expect(FOLLOW_UP).not.toMatch(/https?:|www\.|—/);
  });
});

describe("remindInterviews", () => {
  it("pings once for an interview within two hours", async () => {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    const u = store.listUsers(true)[0]!;
    const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Acme", state: "invited", lastSeenAt: "" });
    const far = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n2", isBot: false, vacancyId: null, employer: "Later", state: "invited", lastSeenAt: "" });
    store.setChatInterview(t.id, "2026-09-23T13:30:00.000Z");
    store.setChatInterview(far.id, "2026-09-24T13:30:00.000Z");
    const alerts: string[] = [];
    const notifier = { report: async () => undefined, alert: async (title: string, body: string) => void alerts.push(`${title}\n${body}`) };
    await remindInterviews(store, notifier, "Europe/Moscow", now);
    await remindInterviews(store, notifier, "Europe/Moscow", now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Через 90 мин собеседование: Acme");
    expect(alerts[0]).toContain("23.09 16:30");
  });
});

describe("formatPrep", () => {
  it("skips empty sections", () => {
    const text = formatPrep({ questions: ["Как устроен GC в Go?"], stories: [{ skill: "Go", prompt: "сервис заказов" }], gaps: [], ask_them: ["Какой стек у команды?"] });
    expect(text).toContain("• Как устроен GC в Go?");
    expect(text).toContain("• Go: сервис заказов");
    expect(text).not.toContain("Пробелы");
  });
});

describe("askOutcomes", () => {
  it("asks once, 20h-3d after the interview, and a new interview time re-arms it", async () => {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    const u = store.listUsers(true)[0]!;
    const mk = (id: string, at: string) => {
      const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: id, isBot: false, vacancyId: null, employer: id, state: "invited", lastSeenAt: "" });
      store.setChatInterview(t.id, at);
      return t;
    };
    const due = mk("Due", "2026-09-22T10:00:00.000Z"); // 26h ago
    mk("Fresh", "2026-09-23T09:00:00.000Z"); // 3h ago: too early
    mk("Old", "2026-09-15T10:00:00.000Z"); // 8 days ago: too late
    const done = mk("Done", "2026-09-22T09:00:00.000Z");
    store.setInterviewOutcome(done.id, "offer");
    const asks: { text: string; data: string[] }[] = [];
    const notifier = { report: async () => undefined, alert: async () => undefined, ask: async (text: string, b: TgButton[] | TgButton[][]) => void asks.push({ text, data: b.flat().map((x) => x.data) }) };
    await askOutcomes(store, notifier, now);
    await askOutcomes(store, notifier, now);
    expect(asks).toEqual([{ text: "Как прошло собеседование в Due?", data: ["next", "rejected", "silence", "offer"].map((o) => `io:${due.id}:${o}`) }]);
    store.setChatInterview(due.id, "2026-09-22T10:00:00.000Z"); // same time: stays asked
    await askOutcomes(store, notifier, now);
    expect(asks).toHaveLength(1);
    store.setChatInterview(due.id, "2026-09-22T11:00:00.000Z"); // next round
    await askOutcomes(store, notifier, now);
    expect(asks).toHaveLength(2);
    expect(store.listChatThreads(u.id).find((t) => t.id === done.id)?.interviewOutcome).toBe("offer");
  });

  it("without buttons nothing is claimed", async () => {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    const u = store.listUsers(true)[0]!;
    const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n", isBot: false, vacancyId: null, employer: "A", state: "invited", lastSeenAt: "" });
    store.setChatInterview(t.id, "2026-09-22T10:00:00.000Z");
    await askOutcomes(store, { report: async () => undefined, alert: async () => undefined }, now);
    expect(store.claimOutcomeAsks("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z")).toHaveLength(1);
  });

  it("parses the callback", () => {
    expect(parseOutcomeCallback("io:12:offer")).toEqual({ threadId: 12, outcome: "offer" });
    expect(parseOutcomeCallback("io:12:maybe")).toBeNull();
    expect(parseOutcomeCallback("q:s:12")).toBeNull();
  });
});

describe("marketLine", () => {
  it("uses the application's CV direction and stays empty without one", () => {
    const band = { n: 30, p25: 200_000, p50: 250_000, p75: 300_000 };
    const seen: unknown[] = [];
    const store = (direction: string) => ({
      lastApplication: () => ({ direction, llmDecision: null }) as never,
      salaryBand: (q: unknown) => (seen.push(q), band),
    });
    expect(marketLine(store("go-backend"), 1, { id: 5 })).toBe("💰 Рынок (go-backend, вилки в вакансиях за 90 дней): 200k-300k, медиана 250k (n=30)");
    expect(seen).toEqual([{ userId: 1, direction: "go-backend" }]);
    expect(marketLine(store(""), 1, { id: 5 })).toBe("");
  });
});
