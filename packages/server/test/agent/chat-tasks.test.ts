// Chat reply tasks end to end: sync -> triage -> review (one KB card) -> draft -> send.
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_AFTER_MS, REMIND_AFTER_MS, SEND_RESYNC_MS } from "../../src/agent/chats/tasks.js";
import { chatHarness, inMsg } from "./harness.js";

let h: ReturnType<typeof chatHarness>;
afterEach(() => h?.store.close());

const tap = (label: string, card?: (typeof h.asks)[number]) => h.tap(label, card);

describe("chat reply tasks", () => {
  it("a question about known skills is answered, confirmed on the page and marked handled", async () => {
    h = chatHarness();
    h.store.setSetting("kb_review_mode", "off");
    h.page.messages = [inMsg("1", "Есть опыт с React?")];
    h.llm.onTriageChat = () => ({ kind: "question", topics: ["react"] });
    h.llm.onAnswerChat = () => ({ reply: "Да, React 2 года.", needs_human: false, reason: "" });
    await h.sync();
    expect(h.asks).toHaveLength(0); // review off, React is in verified_skills: no card
    expect(h.sends("Да, React 2 года.")).toBe(1);
    const [task] = h.tasks();
    expect(task).toMatchObject({ state: "sent", draft: "Да, React 2 года.", topics: [{ name: "react", answer: "yes", by: "profile" }] });
    const msgs = h.store.listChatMessages(h.thread().id);
    expect(msgs.filter((m) => m.direction === "in").every((m) => m.answered)).toBe(true);
    expect(msgs.filter((m) => m.direction === "out")).toHaveLength(1); // the local copy; hh's copy is skipped
    expect(msgs.find((m) => m.direction === "out")!.hhMessageId).toBeNull();
    // A quick re-sync is queued ~30 s after the send.
    const resync = h.store.listJobs("queued", 10).find((j) => j.kind === "chats.sync")!;
    expect(Date.parse(resync.runAfter) - h.now().getTime()).toBe(SEND_RESYNC_MS);
    h.advance(SEND_RESYNC_MS);
    await h.drain();
    expect(h.sends()).toBe(1); // no double reply
  });

  it("ack-only turns are closed without a reply", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Спасибо за отклик, вернёмся с обратной связью.")];
    h.llm.onTriageChat = () => ({ kind: "ack_only", topics: [] });
    await h.sync();
    expect(h.sends()).toBe(0);
    expect(h.tasks()[0]!.state).toBe("closed");
    expect(h.llm.calls.some((c) => c.method === "answerChat")).toBe(false);
  });

  it.each([
    ["two confirmed", ["Подтвердить Jest", "Подтвердить Vitest"], { verified: ["Jest", "Vitest"], never: [] }],
    ["two denied", ["Нет навыка Jest", "Нет навыка Vitest"], { verified: [], never: ["Jest", "Vitest"] }],
    ["mixed", ["Подтвердить Jest", "Нет навыка Vitest"], { verified: ["Jest"], never: ["Vitest"] }],
  ])("one card for two topics: %s", async (_name, labels, want) => {
    h = chatHarness();
    h.story("Jest");
    h.story("Vitest");
    h.page.messages = [inMsg("1", "Писали тесты на Jest или Vitest?")];
    h.llm.onTriageChat = () => ({ kind: "question", topics: ["Jest", "Vitest"] });
    let seen: string[] = [];
    h.llm.onAnswerChat = (p) => ((seen = [...p.verified_skills, "|", ...p.never_claim_skills]), { reply: "Ответ.", needs_human: false, reason: "" });
    await h.sync();
    expect(h.asks).toHaveLength(1);
    expect(h.labels()).toEqual([
      ["Подтвердить Jest", "Дополнить Jest", "Нет навыка Jest"],
      ["Подтвердить Vitest", "Дополнить Vitest", "Нет навыка Vitest"],
    ]);
    expect(h.tasks()[0]!.state).toBe("awaiting_review");

    const first = tap(labels[0]!);
    // The same card is edited: one row left, the task still waits.
    expect(typeof first).toBe("object");
    expect((first as { buttons: unknown[][] }).buttons).toHaveLength(1);
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("awaiting_review");
    expect(h.sends()).toBe(0);

    const second = tap(labels[1]!) as { buttons: unknown[][]; text: string };
    expect(second.buttons).toHaveLength(0);
    expect(second.text).toContain("готовлю ответ");
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("sent");
    for (const s of want.verified) expect(seen.slice(0, seen.indexOf("|"))).toContain(s);
    for (const s of want.never) expect(seen.slice(seen.indexOf("|"))).toContain(s);
    // Answers are remembered: the KB tag status and the profile lists.
    const p = h.store.getProfile(h.user.id)!;
    expect(p.verified_skills.includes("Jest")).toBe(want.verified.includes("Jest"));
    expect(h.store.listKbTags(h.user.id).find((t) => t.name === "Jest")!.status).toBe(want.verified.includes("Jest") ? "yes" : "no");
    expect(tap(labels[0]!, h.asks[0])).toMatchObject({ note: "уже учтено" }); // a double tap changes nothing
  });

  it("the employer writing again before the send supersedes the task and keeps the answers", async () => {
    h = chatHarness();
    h.story("Jest");
    h.page.messages = [inMsg("1", "Есть опыт с Jest?")];
    h.llm.onTriageChat = (_p, _h, fresh) => ({ kind: "question", topics: fresh.some((m) => m.text.includes("Docker")) ? ["Jest", "Docker"] : ["Jest"] });
    await h.sync();
    tap("Подтвердить Jest");
    h.page.messages.push(inMsg("2", "И с Docker?"));
    h.page.lastModified = "2026-09-25T11:00:00.000Z";
    // The draft was ready, but chats.send reads the page first: the new message supersedes it.
    await h.drain();
    const [old, fresh] = h.tasks();
    expect(old!.state).toBe("superseded");
    expect(fresh).toMatchObject({ state: "awaiting_review", topics: [{ name: "Jest", answer: "yes" }, { name: "Docker", answer: null }] });
    expect(fresh!.messageIds).toHaveLength(2);
    expect(h.sends()).toBe(0);
    // A tap on the old card goes to the open task.
    expect(h.labels()).toEqual([["Дополнить Docker", "Нет навыка Docker"]]);
    tap("Нет навыка Docker");
    await h.drain();
    expect(h.tasks().at(-1)!.state).toBe("sent");
    expect(h.sends()).toBe(1);
  });

  it("a sync during review supersedes on a new employer message", async () => {
    h = chatHarness();
    h.story("Jest");
    h.page.messages = [inMsg("1", "Есть опыт с Jest?")];
    h.llm.onTriageChat = () => ({ kind: "question", topics: ["Jest"] });
    await h.sync();
    h.page.messages.push(inMsg("2", "Ответьте, пожалуйста"));
    h.page.lastModified = "2026-09-25T11:00:00.000Z";
    await h.sync();
    expect(h.tasks().map((t) => t.state)).toEqual(["superseded", "awaiting_review"]);
    // The old card's button still answers (mapped to the open task by tag).
    tap("Подтвердить Jest", h.asks[0]);
    await h.drain();
    expect(h.tasks().at(-1)!.state).toBe("sent");
  });

  it("never replies twice when the send confirm failed but the message is on the page", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Готовы к офису?")];
    h.page.failAfterSend = true;
    await h.drain();
    await h.sync(); // attempt 1 throws after the message reached the page
    expect(h.sends()).toBe(1);
    expect(h.tasks()[0]!.state).toBe("sending");
    h.advance(60_000); // backoff
    await h.drain();
    expect(h.sends()).toBe(1);
    expect(h.tasks()[0]!.state).toBe("sent");
    expect(h.store.listChatMessages(h.thread().id).filter((m) => m.direction === "out")).toHaveLength(1);
  });

  it("a send that keeps failing marks the task failed, alerts once and is not reopened until the employer writes", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Готовы к офису?")];
    h.hh.sendMessage.mockRejectedValue(new Error("no send button"));
    await h.sync();
    for (let i = 0; i < 5; i++) {
      h.advance(30 * 60_000);
      await h.drain();
    }
    expect(h.tasks().map((t) => t.state)).toEqual(["failed"]);
    // The click may have happened: the retry does not click again, the human is told which employer waits.
    expect(h.sends()).toBe(1);
    expect(h.alerts("Не ответил работодателю: Acme")).toHaveLength(1);
    await h.sync();
    expect(h.tasks()).toHaveLength(1);
    h.page.messages.push(inMsg("2", "Ау?"));
    h.page.lastModified = "2026-09-26T10:00:00.000Z";
    await h.sync();
    expect(h.tasks()).toHaveLength(2);
    expect(h.tasks()[1]!.messageIds).toHaveLength(2);
  });

  it("reminds after 2 h once, answers honestly without the skill after 12 h", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Опыт с Rust?")];
    h.llm.onTriageChat = () => ({ kind: "question", topics: ["Rust"] });
    let never: string[] = [];
    h.llm.onAnswerChat = (p) => ((never = p.never_claim_skills), { reply: "С Rust в продакшене не работал, пишу на Go.", needs_human: false, reason: "" });
    await h.sync();
    h.advance(REMIND_AFTER_MS);
    await h.drain();
    expect(h.asks).toHaveLength(2);
    expect(h.asks[1]!.text).toContain("Напоминание");
    h.advance(FALLBACK_AFTER_MS - REMIND_AFTER_MS);
    await h.drain();
    expect(h.tasks()[0]).toMatchObject({ state: "sent", topics: [{ name: "Rust", answer: "no", by: "fallback" }] });
    expect(never).toContain("Rust");
    expect(h.alerts("Отвечаю без тебя")).toHaveLength(1);
    expect(h.store.getProfile(h.user.id)!.never_claim_skills).not.toContain("Rust"); // not the human's answer
  });

  it("a skill the draft finds that triage missed goes back to the card", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Пишете на Elixir?")];
    h.llm.onAnswerChat = (p) => (p.never_claim_skills.includes("Elixir") ? { reply: "С Elixir не работал, пишу на Go.", needs_human: false, reason: "" } : { reply: "", needs_human: false, reason: "", unknown_skills: ["Elixir"] });
    await h.sync();
    expect(h.tasks()[0]!.state).toBe("awaiting_review");
    tap("Нет навыка Elixir");
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("sent");
  });

  it("a draft that needs a human alerts, captures the interview time and still sends", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Завтра в 11 созвонимся?")];
    h.llm.onAnswerChat = () => ({ reply: "Да, удобно.", needs_human: true, reason: "time", interview_at: "2026-09-26T08:00:00.000Z" });
    await h.sync();
    expect(h.thread()).toMatchObject({ state: "needs_human", interviewAt: "2026-09-26T08:00:00.000Z" });
    expect(h.alerts("Чат требует внимания")).toHaveLength(1);
    expect(h.sends()).toBe(1);
  });
});
