// Agent bugs from review round 3: what reaches the employer (no double sends, no denied real skills), no lost
// Telegram answers (outages, stale «Дополнить» waits, second stories), and chats.sync edge cases.
import { afterEach, describe, expect, it, vi } from "vitest";
import { kbText } from "../../src/agent/chats/review.js";
import { FALLBACK_AFTER_MS } from "../../src/agent/chats/tasks.js";
import type { HabrClient } from "../../src/habr/client.js";
import { chatHarness, inMsg, outMsg, TG_CHAT } from "./harness.js";

let h: ReturnType<typeof chatHarness>;
afterEach(() => {
  h?.store.close();
  h = undefined as never;
});

const reviews = () => h.store.listKbReviews(h.tasks().at(-1)!.id);
const tag = (name: string) => h.store.listKbTags(h.user.id).find((t) => t.name === name)!;
const answerChats = () => h.llm.calls.filter((c) => c.method === "answerChat");

async function ask(topics: string[], text = `Есть опыт с ${topics.join(", ")}?`) {
  h.page.messages = [inMsg("1", text)];
  h.llm.onTriageChat = () => ({ kind: "question", topics });
  h.llm.onAnswerChat = () => ({ reply: "Ответ.", needs_human: false, reason: "" });
  await h.sync();
}

describe("fallback and review timers", () => {
  it("the 12 h fallback answers a verified skill «yes» and says «нет» only for unknown ones", async () => {
    h = chatHarness();
    await ask(["Go", "Rust"]);
    h.advance(FALLBACK_AFTER_MS);
    await h.drain();
    expect(h.tasks()[0]).toMatchObject({ state: "sent", topics: [{ name: "Go", answer: "yes", by: "profile" }, { name: "Rust", answer: "no", by: "fallback" }] });
    const profile = answerChats().at(-1)!.args[0] as { verified_skills: string[]; never_claim_skills: string[] };
    expect(profile.verified_skills).toContain("Go");
    expect(profile.never_claim_skills).not.toContain("Go");
    expect(String(h.alerts("Отвечаю без тебя")[0]![1])).toContain("Без заявлений о навыках: Rust.");
  });

  it("a Telegram outage while asking does not fail the task: the fallback still answers", async () => {
    h = chatHarness();
    h.notifier.ask.mockRejectedValue(new Error("telegram: giving up after 3 attempts"));
    await ask(["Rust"]);
    expect(h.tasks()[0]!.state).toBe("awaiting_review");
    h.advance(FALLBACK_AFTER_MS);
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("sent");
  });

  it("a topic the draft adds late gets its own 12 h and reminder, not the old round's deadline", async () => {
    h = chatHarness();
    await ask(["Jest"]);
    let n = 0;
    h.llm.onAnswerChat = () => (n++ === 0 ? { reply: "", needs_human: false, reason: "", unknown_skills: ["Vitest"] } : { reply: "Ответ.", needs_human: false, reason: "" });
    h.advance(FALLBACK_AFTER_MS - 10 * 60_000);
    await h.drain(); // the round-1 reminder fired
    h.tap("Нет навыка Jest");
    await h.drain();
    expect(h.tasks()[0]).toMatchObject({ state: "awaiting_review", reminded: false });
    h.advance(20 * 60_000); // past the round-1 deadline
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("awaiting_review");
    const asked = h.asks.length;
    h.advance(2 * 3600_000);
    await h.drain();
    expect(h.asks.length).toBe(asked + 1); // the new round's reminder
    h.advance(FALLBACK_AFTER_MS);
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("sent");
  });
});

describe("«Дополнить» waits and kb.ingest", () => {
  it("answering by hand closes the task and drops its «Дополнить» wait: later text is not a KB story", async () => {
    h = chatHarness();
    await ask(["Vitest"]);
    h.tap("Дополнить Vitest");
    h.page.messages.push(outMsg("2", "Ответил сам"));
    h.page.lastModified = "2026-09-25T11:00:00.000Z";
    await h.sync();
    expect(h.tasks()[0]!.state).toBe("closed");
    expect(reviews()[0]!.state).toBe("expired");
    expect(kbText(h.env, TG_CHAT, "ответ на /mock")).toBeNull();
    expect(tag("Vitest").status).toBe("unknown");
  });

  it("a second story for the same topic while the first waits for the LLM is saved too", async () => {
    h = chatHarness();
    await ask(["Vitest"]);
    h.llm.onJson = (_t, _tier, prompt) => ({ stories: [{ title: "История", company: "", period: "", context: "", did: prompt.includes("первый") ? "Первый рассказ." : "Второй рассказ.", result: "", tags: [] }] });
    h.tap("Дополнить Vitest");
    kbText(h.env, TG_CHAT, "первый текст");
    h.tap("Дополнить Vitest");
    expect(kbText(h.env, TG_CHAT, "второй, подробнее")).toBe("Принял, записываю историю про Vitest.");
    await h.drain();
    expect(h.store.listKbStories(h.user.id, tag("Vitest").id).map((s) => s.did).sort()).toEqual(["Второй рассказ.", "Первый рассказ."]);
  });

  it("«Нет навыка» tapped while the story is being ingested wins: the tag stays «no»", async () => {
    h = chatHarness();
    await ask(["Vitest", "Jest"]);
    const card = h.asks[0]!;
    h.tap("Дополнить Vitest");
    h.llm.onJson = () => {
      h.tap("Нет навыка Vitest", card); // during the LLM call
      return { stories: [{ title: "История", company: "", period: "", context: "", did: "Писал на Vitest.", result: "", tags: [] }] };
    };
    kbText(h.env, TG_CHAT, "Писал тесты на Vitest");
    await h.drain();
    expect(tag("Vitest").status).toBe("no");
    expect(h.store.listKbStories(h.user.id, tag("Vitest").id)).toHaveLength(0);
    expect(reviews()[0]!.state).toBe("denied");
  });

  it("an ingest that keeps failing tells the human per topic and brings the card's buttons back", async () => {
    h = chatHarness();
    await ask(["Vitest"]);
    h.tap("Дополнить Vitest");
    h.llm.onJson = () => {
      throw new Error("claude: quota");
    };
    kbText(h.env, TG_CHAT, "Писал тесты на Vitest");
    for (let i = 0; i < 6; i++) {
      await h.drain();
      h.advance(30 * 60_000);
    }
    expect(h.alerts("Не записал историю")).toHaveLength(1);
    expect(h.alerts("Агент: задача kb.ingest")).toHaveLength(0);
    const [, text, buttons] = h.notifier.edit.mock.calls.at(-1)!;
    expect(text).not.toContain("жду твой рассказ");
    expect(buttons.flat().map((b) => b.text)).toContain("Дополнить Vitest");
  });

  it("an ingest with nothing usable re-renders the card too", async () => {
    h = chatHarness();
    await ask(["Vitest"]);
    h.tap("Дополнить Vitest");
    h.llm.onJson = () => ({ stories: [] });
    kbText(h.env, TG_CHAT, "ну было");
    await h.drain();
    expect(String(h.notifier.edit.mock.calls.at(-1)![1])).not.toContain("жду твой рассказ");
  });

  it("«Подтвердить» confirms only the stories the card could show", async () => {
    h = chatHarness();
    const topics = ["Jest", "Vitest", "Cypress", "Playwright", "Mocha", "Karma"];
    for (const t of topics) for (let i = 0; i < 3; i++) h.story(t, { title: `${t} ${"история ".repeat(12)}${i}`, did: "Очень длинное описание & <деталей>. ".repeat(10), result: "Итог ".repeat(30) });
    await ask(topics, "Вопрос ".repeat(200));
    const shown = h.env.review.storiesShown(h.tasks()[0]!);
    expect(shown).toBeLessThan(3);
    h.tap("Подтвердить Jest");
    expect(h.store.listKbStories(h.user.id, tag("Jest").id).filter((s) => s.confirmed)).toHaveLength(shown);
  });
});

describe("drafting", () => {
  it("Go and its alias Golang in one question: one tap answers both, no second card, no fallback «нет»", async () => {
    h = chatHarness();
    h.store.upsertKbTag(h.user.id, { name: "Go", aliases: ["Golang"], status: "yes" });
    h.story("Go");
    await ask(["Go", "Golang"]);
    h.tap("Подтвердить Go");
    await h.drain();
    expect(h.tasks()[0]).toMatchObject({ state: "sent", topics: [{ name: "Go", answer: "yes" }, { name: "Golang", answer: "yes" }] });
  });

  it("the draft asking again about an answered skill (or its alias) fails once to the human, no retry loop", async () => {
    h = chatHarness();
    h.store.upsertKbTag(h.user.id, { name: "Postgres", aliases: ["PostgreSQL"], status: "unknown" });
    await ask(["Postgres"]);
    h.llm.onAnswerChat = () => ({ reply: "Ответ.", needs_human: false, reason: "", unknown_skills: ["PostgreSQL"] });
    const cards = h.asks.length;
    h.tap("Нет навыка Postgres");
    for (let i = 0; i < 5; i++) {
      await h.drain();
      h.advance(30 * 60_000);
    }
    expect(answerChats()).toHaveLength(1);
    expect(h.asks.length).toBe(cards);
    expect(h.tasks()[0]!.state).toBe("failed");
    expect(h.alerts("Не ответил работодателю: Acme")).toHaveLength(1);
  });

  it("a draft needing a human keeps an invitation that arrived during the LLM call", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Когда удобно созвониться?")];
    h.llm.onAnswerChat = () => {
      h.store.upsertChatThread({ ...h.thread(), state: "invited" }); // a sync ran meanwhile
      return { reply: "Завтра в 11.", needs_human: true, reason: "время" };
    };
    await h.sync();
    expect(h.thread().state).toBe("invited");
  });
});

describe("chats.send", () => {
  const long = "Привет! Да, работал с этим стеком в продакшне три года, могу рассказать подробнее на созвоне. Готов обсудить детали.";
  const reply = () => (h.llm.onAnswerChat = () => ({ reply: long, needs_human: false, reason: "" }));

  it("a sent reply the page renders differently is not sent again", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Готовы к офису?")];
    reply();
    h.hh.sendMessage.mockImplementation(async (_s, _u, text: string) => void h.page.messages.push(outMsg("o1", text.replace("Привет!", "Привет !"))));
    await h.sync();
    h.advance(30 * 60_000);
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("sent");
    expect(h.sends()).toBe(1);
  });

  it("a retry after the click confirms by the start of the text and never clicks again", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Готовы к офису?")];
    reply();
    h.hh.sendMessage.mockImplementationOnce(async (_s, _u, text: string) => {
      h.page.messages.push(outMsg("o1", `${text.slice(0, 80)}…`)); // on the page, parsed truncated
      throw new Error("sendMessage: the sent message did not appear in the thread");
    });
    await h.sync();
    for (let i = 0; i < 3; i++) {
      h.advance(30 * 60_000);
      await h.drain();
    }
    expect(h.tasks()[0]!.state).toBe("sent");
    expect(h.sends()).toBe(1);
  });
});

describe("chats.sync", () => {
  it("hh: a typed employer question next to a survey still gets a reply task", async () => {
    h = chatHarness();
    h.page.survey = [{ idx: 0, text: "Опыт с Go?", kind: "text", required: true }];
    h.page.messages = [inMsg("1", "Опыт с Go?"), inMsg("2", "И пришлите зарплатные ожидания")];
    await h.sync();
    expect(h.hh.submitSurvey).toHaveBeenCalledTimes(1);
    const ids = h.store.listChatMessages(h.thread().id).filter((m) => m.hhMessageId === "2").map((m) => m.id);
    expect(h.tasks()).toHaveLength(1);
    expect(h.tasks()[0]!.messageIds).toEqual(ids);
  });

  it("hh: a failed feedback request still marks the rejection handled (never forwarded as feedback)", async () => {
    h = chatHarness();
    h.page.rejected = true;
    h.page.messages = [inMsg("1", "К сожалению, мы выбрали другого кандидата.")];
    h.hh.sendMessage.mockRejectedValue(new Error("no send button"));
    await h.sync();
    h.page.lastModified = "2026-09-25T12:00:00.000Z";
    await h.sync();
    expect(h.alerts("Фидбек")).toHaveLength(0);
  });

  it("Habr: its «договорились о работе?» survey does not swallow the recruiter's pending question", async () => {
    const page = [
      { id: "m1", mine: false, text: "Готовы к офису?" },
      { id: "q9", mine: false, text: "Вы договорились о работе?" },
    ];
    const client = {
      listConversations: vi.fn(async () => ({ conversations: [{ login: "hr3", name: "HR", company: "Acme", subtitle: "", unread: 1, banned: false, lastMessage: { id: "q9", createdAt: "2026-09-24 10:00:00", isMine: false, kind: "question", text: "?" } }], myAvatar: "" })),
      readConversation: vi.fn(async () => ({ messages: page.map((m) => ({ ...m })), writable: true })),
      sendMessage: vi.fn(async (_s: unknown, _l: string, text: string) => void page.push({ id: `s${page.length}`, mine: true, text })),
    } as unknown as HabrClient & { sendMessage: ReturnType<typeof vi.fn> };
    h = chatHarness({ habr: client });
    h.hh.listThreads.mockResolvedValue([]);
    await h.sync();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.tasks()[0]!.state).toBe("sent");
  });
});
