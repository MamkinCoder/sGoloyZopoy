// chats.sync side effects kept from the runner's old chat stage: invitations, rejections, feedback, surveys,
// hh send times, vacancy linking (hh), and the Habr conversation rules.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRow } from "@sgz/shared";
import { CHAT_LIST_MAX_OPENS, CHAT_LIST_MAX_PAGES, FEEDBACK_REQUEST } from "../../src/agent/chats/hh.js";
import type { HabrClient } from "../../src/habr/client.js";
import type { HabrConversation, HabrMessage } from "../../src/habr/state.js";
import { chatHarness, inMsg, outMsg } from "./harness.js";

let h: ReturnType<typeof chatHarness>;
afterEach(() => h?.store.close());

describe("chats.sync (hh)", () => {
  it("skips a placeholder user without a profile instead of failing the job", async () => {
    h = chatHarness();
    h.store.upsertUser({ slug: "ghost", name: "G", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
    await h.sync();
    expect(h.hh.listThreads).toHaveBeenCalledTimes(1);
  });

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

describe("chats.sync (hh chat list: employer-initiated chats)", () => {
  const outreach = (id: string, o: Partial<ThreadRow> = {}): ThreadRow => ({ negotiationId: `chat:${id}`, chatUrl: `https://hh.ru/chat/${id}`, unread: true, employer: "Coding Team", state: "", vacancyExternalId: "136745560", lastModified: "2026-09-24T05:07:20.808Z", ...o });
  const HELLO = "Здравствуйте, Иван! Я представляю компанию Coding Team. Сейчас открыта вакансия frontend vue 3 разработчика. Хотите, расскажу подробнее?";

  it("a chat only in the chat list becomes a thread and its task is replied to", async () => {
    h = chatHarness();
    h.hh.listThreads.mockResolvedValue([]);
    h.page.chats = [outreach("5655372160")];
    h.page.messages = [{ ...inMsg("1", HELLO), author: "bot" }];
    await h.sync();
    const t = h.thread();
    expect(t.hhNegotiationId).toBe("chat:5655372160");
    expect(t.vacancyId).not.toBeNull(); // the vacancy was fetched for the draft
    expect(h.tasks()).toMatchObject([{ state: "sent", target: "https://hh.ru/chat/5655372160" }]);
    expect(h.hh.sendMessage).toHaveBeenCalledWith({}, "https://hh.ru/chat/5655372160", "Да, готов обсудить детали.");
    const note = h.alerts("✉️ Работодатель написал первым");
    expect(note).toHaveLength(1);
    expect(String(note[0]![1])).toContain("https://hh.ru/vacancy/136745560");
    await h.sync(); // nothing new: no second reply, no second note
    expect(h.sends()).toBe(1);
    expect(h.alerts("✉️")).toHaveLength(1);
  });

  it("a chat also in the negotiations list is one thread, keyed by its topic", async () => {
    h = chatHarness();
    h.page.chats = [outreach("999", { negotiationId: "n1", employer: "Acme" })];
    h.page.messages = [inMsg("1", "Когда готовы выйти?")];
    await h.sync();
    expect(h.store.listChatThreads(h.user.id).map((t) => t.hhNegotiationId)).toEqual(["n1"]);
    expect(h.hh.readThread.mock.calls.map((c) => c[1])).not.toContain("https://hh.ru/chat/999");
    expect(h.alerts("✉️")).toHaveLength(0);
  });

  it("the seeker answered by hand: nothing is sent; a later bot question gets a reply of its own", async () => {
    h = chatHarness();
    h.hh.listThreads.mockResolvedValue([]);
    h.page.chats = [outreach("5655382625", { employer: "Арктический Научный Центр" })];
    h.page.messages = [{ ...inMsg("1", HELLO), author: "bot" }, outMsg("2", "Здравствуйте, интересно"), { ...inMsg("3", "Хотите откликнуться на эту вакансию?"), author: "bot" }, outMsg("4", "Да!")];
    await h.sync();
    expect(h.sends()).toBe(0);
    expect(h.tasks()).toHaveLength(0);
    h.page.messages.push({ ...inMsg("5", "Сталкивались ли вы с платформой ELMA365?"), author: "bot" });
    h.page.chats = [outreach("5655382625", { employer: "Арктический Научный Центр", lastModified: "2026-09-25T09:00:00.000Z" })];
    await h.sync();
    const task = h.tasks()[0]!;
    const texts = h.store.listChatMessages(h.thread().id).filter((m) => task.messageIds.includes(m.id)).map((m) => m.text);
    expect(texts).toEqual(["Сталкивались ли вы с платформой ELMA365?"]); // only what came after our last message
  });

  it("opens at most CHAT_LIST_MAX_OPENS chat-list chats per sync, newest first", async () => {
    h = chatHarness();
    h.hh.listThreads.mockResolvedValue([]);
    h.page.chats = Array.from({ length: CHAT_LIST_MAX_OPENS + 3 }, (_, i) => outreach(String(100 + i), { unread: false })); // opening a chat reads it
    h.page.messages = [{ ...inMsg("1", "Здравствуйте! Интересно ли узнать больше?"), author: "bot" }];
    h.llm.onTriageChat = () => ({ kind: "ack_only", topics: [] }); // no sends: the fake page is shared by every chat
    await h.sync();
    expect(h.hh.readThread.mock.calls.slice(0, CHAT_LIST_MAX_OPENS).map((c) => c[1])).toEqual(h.page.chats.slice(0, CHAT_LIST_MAX_OPENS).map((c) => c.chatUrl));
    expect(h.store.listChatThreads(h.user.id)).toHaveLength(CHAT_LIST_MAX_OPENS);
    expect(h.hh.listChats).toHaveBeenLastCalledWith({}, "2026-09-22T21:00:00.000Z", CHAT_LIST_MAX_PAGES); // chat_track_since
    await h.sync(); // the rest are opened next time
    expect(h.store.listChatThreads(h.user.id)).toHaveLength(CHAT_LIST_MAX_OPENS + 3);
    // Everything handled: the next read only pages back to the previous read (minus an hour).
    await h.sync();
    expect(h.hh.listChats).toHaveBeenLastCalledWith({}, "2026-09-25T09:00:00.000Z", CHAT_LIST_MAX_PAGES);
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
    const surveyed = [
      { id: "m5", mine: false, text: "Добрый день! Посмотрели резюме" },
      { id: "m6", mine: true, text: "Спасибо!" },
    ];
    hb.client.readConversation.mockImplementation(async (_s: unknown, login: string) => ({ messages: login === "habrbot" ? surveyed : hb.page, writable: true }));
    h = chatHarness({ habr: hb.client });
    h.hh.listThreads.mockResolvedValue([]);
    await h.sync();
    expect(hb.client.sendMessage).not.toHaveBeenCalled();
    expect(h.notifier.alert).toHaveBeenCalledTimes(1);
    expect(String(h.notifier.alert.mock.calls[0]![1])).toContain("Да, кинь файл");
    expect(h.tasks()).toHaveLength(0);
  });

  it("Habr's survey after a recruiter's question does not swallow it; a survey-only thread is not re-read every sync", async () => {
    const hb = habrClient([conv("hr3", false, "question", "q1")], [{ id: "m1", mine: false, text: "Когда удобно созвониться?" }]);
    h = chatHarness({ habr: hb.client });
    h.hh.listThreads.mockResolvedValue([]);
    await h.sync();
    expect(hb.client.sendMessage).toHaveBeenCalledTimes(1); // the recruiter's question is answered
    await h.sync();
    await h.sync();
    // The survey card (q1) never appears among the page's messages: remembered, so no page load per sync.
    const reads = hb.client.readConversation.mock.calls.length;
    await h.sync();
    expect(hb.client.readConversation.mock.calls.length).toBe(reads);
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
