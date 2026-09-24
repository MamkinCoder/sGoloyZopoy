// chats.sync side effects kept from the runner's old chat stage: invitations, rejections, feedback, surveys,
// hh send times, vacancy linking (hh), and the Habr conversation rules.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_REQUEST } from "../../src/agent/chats/hh.js";
import type { HabrClient } from "../../src/habr/client.js";
import type { HabrConversation, HabrMessage } from "../../src/habr/state.js";
import { chatHarness, inMsg, outMsg } from "./harness.js";

let h: ReturnType<typeof chatHarness>;
afterEach(() => h?.store.close());

describe("chats.sync (hh)", () => {
  it("links an invitation's vacancy that was never stored, fetching it only once, and preps once", async () => {
    h = chatHarness();
    h.page.state = "INVITATION";
    h.page.ext = "777";
    h.page.messages = [inMsg("1", "Приглашаем на собеседование")];
    await h.sync();
    expect(h.hh.fetchVacancy).toHaveBeenCalledTimes(1);
    expect(h.thread().vacancyId).not.toBeNull();
    expect(h.thread().prep).not.toBeNull(); // chats.prep ran
    h.page.lastModified = "2026-09-26T10:00:00.000Z";
    await h.sync();
    expect(h.hh.fetchVacancy).toHaveBeenCalledTimes(1);
    expect(h.llm.calls.filter((c) => c.method === "interviewPrep")).toHaveLength(1);
  });

  it("a rejection on a needs_human thread asks for feedback once and the thread becomes rejected", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Пришлём тестовое, выполните?")];
    h.llm.onAnswerChat = () => ({ reply: "Да, пришлите.", needs_human: true, reason: "test task" });
    await h.sync();
    expect(h.thread().state).toBe("needs_human");
    h.page.rejected = true;
    h.page.messages = [...h.page.messages, inMsg("2", "Спасибо, но мы выбрали другого кандидата.")];
    h.page.lastModified = "2026-09-25T12:00:00.000Z";
    await h.sync();
    h.page.lastModified = "2026-09-25T13:00:00.000Z";
    await h.sync();
    expect(h.thread().state).toBe("rejected");
    expect(h.sends(FEEDBACK_REQUEST)).toBe(1);
  });

  it("an invited thread that needs a human stays invited and is not re-announced", async () => {
    h = chatHarness();
    h.page.state = "INVITATION";
    h.page.messages = [inMsg("1", "Приглашаем на собеседование, когда удобно?")];
    h.llm.onAnswerChat = () => ({ reply: "", needs_human: true, reason: "time" });
    await h.sync();
    await h.sync();
    expect(h.thread().state).toBe("invited");
    expect(h.alerts("🎉 Приглашение")).toHaveLength(1);
  });

  it("a survey still in the chat state is submitted once", async () => {
    h = chatHarness();
    h.page.survey = [{ idx: 0, text: "Опыт с Go?", kind: "text", required: true }];
    await h.sync();
    h.page.lastModified = "2026-09-25T12:00:00.000Z";
    await h.sync();
    expect(h.hh.submitSurvey).toHaveBeenCalledTimes(1);
  });

  it("after a rejection only new employer messages are forwarded as feedback, never answered", async () => {
    h = chatHarness();
    h.page.rejected = true;
    h.page.messages = [inMsg("1", "К сожалению, мы выбрали другого кандидата.")];
    await h.sync();
    h.page.messages = [...h.page.messages, outMsg("2", "А что не подошло?"), inMsg("3", "Не хватило опыта с Kafka.")];
    h.page.lastModified = "2026-09-25T12:00:00.000Z";
    await h.sync();
    const fb = h.alerts("Фидбек");
    expect(fb).toHaveLength(1);
    expect(String(fb[0]![1])).toContain("Kafka");
    expect(String(fb[0]![1])).not.toContain("другого кандидата");
    expect(h.tasks()).toHaveLength(0);
  });

  it("stores hh's send time as the message time", async () => {
    h = chatHarness();
    h.page.messages = [{ ...inMsg("1", "Завтра в 11 удобно?"), createdAt: "2026-09-24T20:50:00.000Z" }];
    await h.sync();
    expect(h.store.listChatMessages(h.thread().id)[0]!.createdAt).toBe("2026-09-24T20:50:00.000Z");
  });

  it("a reply typed by hand on the phone closes the open task", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Работали с Svelte?")];
    h.llm.onTriageChat = () => ({ kind: "question", topics: ["Svelte"] });
    await h.sync();
    h.page.messages.push(outMsg("2", "Да, немного."));
    h.page.lastModified = "2026-09-25T11:00:00.000Z";
    await h.sync();
    expect(h.tasks()[0]).toMatchObject({ state: "closed" });
    expect(h.sends()).toBe(0);
  });

  it("an hh chat-bot question with buttons passes the choices to the draft", async () => {
    h = chatHarness();
    h.page.messages = [inMsg("1", "Какой формат работы вам подходит?")];
    h.page.choices = ["Офис", "Удалённо"];
    await h.sync();
    const call = h.llm.calls.find((c) => c.method === "answerChat")!;
    expect(call.args[3]).toEqual(["Офис", "Удалённо"]);
  });
});

describe("chats.sync (Habr)", () => {
  const conv = (login: string, isMine: boolean, kind = "message", id = "m2"): HabrConversation => ({ login, name: "HR", company: "Acme", subtitle: "", unread: 1, banned: false, lastMessage: { id, createdAt: "2026-09-24 10:00:00", isMine, kind, text: "?" } });
  const habrClient = (conversations: HabrConversation[], messages: HabrMessage[]) => {
    const page = [...messages];
    return {
      page,
      client: {
        listConversations: vi.fn(async () => ({ conversations, myAvatar: "" })),
        readConversation: vi.fn(async () => ({ messages: page.map((m) => ({ ...m })), writable: true })),
        sendMessage: vi.fn(async (_s: unknown, _login: string, text: string) => void page.push({ id: `s${page.length}`, mine: true, text })),
      } as unknown as HabrClient & { sendMessage: ReturnType<typeof vi.fn>; readConversation: ReturnType<typeof vi.fn> },
    };
  };

  it("answers an employer-started chat through a task and stores it as habr:<login>", async () => {
    const hb = habrClient([conv("hr1", false)], [{ id: "m2", mine: false, text: "Здравствуйте! Готовы к офису?" }]);
    h = chatHarness({ habr: hb.client });
    h.hh.listThreads.mockResolvedValue([]);
    await h.sync();
    expect(hb.client.sendMessage).toHaveBeenCalledWith({}, "hr1", "Да, готов обсудить детали.");
    const thread = h.store.listChatThreads(h.user.id).find((t) => t.hhNegotiationId === "habr:hr1")!;
    expect(thread.employer).toBe("Acme (HR)");
    expect(h.store.listChatMessages(thread.id).map((m) => [m.direction, m.answered])).toEqual([
      ["in", true],
      ["out", true],
    ]);
    expect(h.tasks()[0]).toMatchObject({ state: "sent", target: "hr1" });
  });

  it("never replies in a chat the seeker started: forwards to Telegram; ignores Habr's own survey", async () => {
    const hb = habrClient([conv("friend", false), conv("habrbot", false, "question", "q1")], [
      { id: "m0", mine: true, text: "Привет, закинешь резюме?" },
      { id: "m2", mine: false, text: "Да, кинь файл" },
    ]);
    h = chatHarness({ habr: hb.client });
    h.hh.listThreads.mockResolvedValue([]);
    await h.sync();
    expect(hb.client.sendMessage).not.toHaveBeenCalled();
    expect(h.notifier.alert).toHaveBeenCalledTimes(1);
    expect(String(h.notifier.alert.mock.calls[0]![1])).toContain("Да, кинь файл");
    expect(h.tasks()).toHaveLength(0);
  });

  it("alerts an invitation once", async () => {
    const hb = habrClient([conv("hr2", false, "job_invite")], [{ id: "m1", mine: false, text: "Приглашаем на собеседование" }]);
    h = chatHarness({ habr: hb.client });
    h.hh.listThreads.mockResolvedValue([]);
    h.llm.onAnswerChat = () => ({ reply: "", needs_human: false, reason: "" });
    await h.sync();
    expect(String(h.notifier.alert.mock.calls[0]![0])).toContain("Приглашение");
    expect(h.store.listChatThreads(h.user.id)[0]!.state).toBe("invited");
  });
});
