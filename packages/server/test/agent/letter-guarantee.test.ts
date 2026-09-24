// Letter guarantee: the chat of a SENT hh application without our cover letter gets the stored letter once.
import { afterEach, describe, expect, it } from "vitest";
import { Status } from "@sgz/shared";
import { letterKey } from "../../src/agent/chats/hh.js";
import { chatHarness, inMsg, outMsg } from "./harness.js";

const LETTER = "Привет! Пишу на Go и React пять лет, ваш стек мне близок. Готов обсудить детали.";
let h: ReturnType<typeof chatHarness>;
afterEach(() => h?.store.close());

function applied(o: { letter?: string; status?: Status } = {}) {
  h = chatHarness();
  const v = h.store.upsertVacancy({ source: "hh", externalId: "777", url: "https://hh.ru/vacancy/777", title: "Go dev", company: "Acme", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "acme|go" });
  h.store.insertApplication({ userId: h.user.id, vacancyId: v.id, hhResumeId: null, generatedResumeId: null, runId: 0, status: o.status ?? Status.SENT, reasonDetail: "sent, letter not attached", coverLetter: o.letter ?? LETTER, llmDecision: null, direction: "" });
  h.page.ext = "777";
  h.page.messages = [outMsg("r1", "Отклик на вакансию\nБез сопроводительного письма")];
  return h;
}

describe("letter guarantee (chats.sync hh)", () => {
  it("sends the stored letter once through chats.sync -> chats.send, never twice", async () => {
    applied();
    await h.sync();
    expect(h.sends(LETTER)).toBe(1);
    expect(h.tasks().at(-1)).toMatchObject({ state: "sent", draft: LETTER });
    h.page.lastModified = "2026-09-26T10:00:00.000Z";
    h.advance(3600_000);
    await h.sync();
    await h.sync();
    expect(h.sends()).toBe(1);
  });

  it("an hh no-letter line that parses as an employer message is not a turn and does not block the letter", async () => {
    applied();
    h.page.messages = [inMsg("r1", "Без сопроводительного письма")];
    await h.sync();
    expect(h.sends(LETTER)).toBe(1);
    expect(h.llm.calls.filter((c) => c.method === "triageChat")).toHaveLength(0);
  });

  it.each([
    ["the employer replied", () => h.page.messages.push(inMsg("e1", "Спасибо, посмотрим"))],
    ["the letter is already in the chat", () => (h.page.messages = [outMsg("r1", LETTER)])],
    ["the chat is closed", () => (h.page.writable = false)],
    ["the vacancy was rejected", () => (h.page.rejected = true)],
  ])("skips when %s", async (_why, arrange) => {
    applied();
    arrange();
    await h.sync();
    expect(h.sends(LETTER)).toBe(0);
    expect(h.store.getSetting(letterKey(h.thread().id)) ?? "").not.toMatch(/^task:/);
  });

  it("skips applications without a stored letter or not SENT", async () => {
    applied({ letter: "" });
    await h.sync();
    expect(h.sends(LETTER)).toBe(0);
    h.store.close();
    applied({ status: Status.FAILED_UI });
    await h.sync();
    expect(h.sends(LETTER)).toBe(0);
  });

  it("backfills a known quiet thread whose letter was never checked, once", async () => {
    applied();
    await h.sync();
    // An older thread: sent before the guarantee existed, its marker is gone and nothing changed on hh.
    h.store.db.prepare("DELETE FROM settings WHERE key = ?").run(letterKey(h.thread().id));
    h.store.db.prepare("DELETE FROM chat_messages").run();
    h.page.messages = [outMsg("r1", "Отклик на вакансию\nБез сопроводительного письма")];
    h.hh.sendMessage.mockClear();
    h.hh.readThread.mockClear();
    h.advance(3600_000);
    await h.sync();
    expect(h.hh.readThread).toHaveBeenCalled();
    expect(h.sends(LETTER)).toBe(1);
    h.advance(3600_000);
    await h.sync();
    expect(h.sends()).toBe(1);
  });
});
