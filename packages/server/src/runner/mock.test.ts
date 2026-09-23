import { describe, expect, it } from "vitest";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { FakeLLM } from "../llm/fake.js";
import { MOCK_TTL_MS, loadMock, mockAnswer, startMock, stopMock } from "./mock.js";

const now = new Date("2026-09-23T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

function setup(questions = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]) {
  const store = openStore(":memory:");
  seedDefaultUsers(store);
  const u = store.listUsers(true)[0]!;
  const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Рога и Копыта", state: "invited", lastSeenAt: "2026-09-22T10:00:00Z" });
  store.upsertChatThread({ userId: u.id, hhNegotiationId: "n2", isBot: false, vacancyId: null, employer: "Без подготовки", state: "invited", lastSeenAt: "2026-09-23T10:00:00Z" });
  store.setChatPrep(t.id, { questions, stories: [], gaps: [], ask_them: [] });
  const llm = new FakeLLM();
  llm.onJson = (task) => (task === "mock_summary" ? { tighten: ["Больше конкретики", "Пример из опыта", "Короче"] } : { feedback: "Хорошо, добавь пример.", follow_up: null });
  return { store, llm };
}

describe("mock interview", () => {
  it("starts from the thread with a prep brief, or explains why not", () => {
    const { store } = setup();
    expect(startMock(store, "42", "нет такой", now)).toContain("Нет приглашения");
    expect(startMock(store, "42", "", now)).toContain("Тренировка: Рога и Копыта. 5 вопросов");
    expect(startMock(store, "42", "", now)).toContain("Вопрос 1: Q1");
    const empty = openStore(":memory:");
    seedDefaultUsers(empty);
    expect(startMock(empty, "42", "", now)).toContain("Пока нет приглашений");
  });

  it("walks 5 questions with feedback, then a summary, and clears the session", async () => {
    const { store, llm } = setup();
    startMock(store, "42", "рога", now);
    expect(await mockAnswer(store, llm, "42", "ответ 1", now)).toBe("Хорошо, добавь пример.\n\nВопрос 2: Q2");
    for (let i = 2; i < 5; i++) await mockAnswer(store, llm, "42", `ответ ${i}`, now);
    const last = await mockAnswer(store, llm, "42", "ответ 5", now);
    expect(last).toContain("Тренировка закончена. Что подтянуть:\n• Больше конкретики");
    expect(loadMock(store, "42", now)).toBeNull();
    expect(await mockAnswer(store, llm, "42", "просто текст", now)).toBeNull();
    const fb = llm.calls.find((c) => c.args[0] === "mock_feedback")!.args[2] as string;
    expect(fb).toContain("ответ 1");
    expect(fb).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("asks a follow-up without counting it as a question", async () => {
    const { store, llm } = setup();
    llm.onJson = () => ({ feedback: "Ок.", follow_up: "А почему так?" });
    startMock(store, "42", "", now);
    expect(await mockAnswer(store, llm, "42", "a", now)).toBe("Ок.\n\nУточнение: А почему так?");
    expect(await mockAnswer(store, llm, "42", "b", now)).toBe("Ок.\n\nВопрос 2: Q2"); // no follow-up on a follow-up
  });

  it("keeps the question on a bad LLM answer", async () => {
    const { store, llm } = setup();
    llm.onJson = () => ({ nope: true });
    startMock(store, "42", "", now);
    expect(await mockAnswer(store, llm, "42", "a", now)).toContain("Не получилось разобрать ответ");
    expect(loadMock(store, "42", now)!.idx).toBe(0);
  });

  it("expires after 2 h and /stop ends it", () => {
    const { store } = setup();
    startMock(store, "42", "", now);
    expect(loadMock(store, "42", later(MOCK_TTL_MS - 1000))).not.toBeNull();
    expect(loadMock(store, "42", later(MOCK_TTL_MS))).toBeNull();
    expect(loadMock(store, "7", now)).toBeNull(); // per chat
    expect(stopMock(store, "42", now)).toContain("остановлена после 0");
    expect(loadMock(store, "42", now)).toBeNull();
    expect(stopMock(store, "42", now)).toBe("Тренировки сейчас нет.");
  });
});
