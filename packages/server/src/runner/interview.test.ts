import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatThread } from "@sgz/shared";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { FOLLOW_UP, followupDue, formatPrep, remindInterviews } from "./interview.js";

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
