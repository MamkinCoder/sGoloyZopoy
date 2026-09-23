import { describe, expect, it } from "vitest";
import { Status } from "@sgz/shared";
import { createHHClient } from "../../src/hh/client.js";
import { mapNegotiationState } from "../../src/hh/state.js";
import { FakeSession, fixture } from "./fake-session.js";

const client = createHHClient({ snapshotDir: "/tmp/sgz-hh-test", settleMs: 0, confirmTimeoutMs: 10 });

const vacancy = {
  id: 1,
  source: "hh" as const,
  externalId: "111",
  url: "https://hh.ru/vacancy/111",
  title: "Go разработчик",
  company: "ООО Ромашка",
  salaryFrom: 150000,
  salaryTo: 200000,
  currency: "RUR",
  descriptionText: "Ищем Go разработчика.",
  hasTest: false,
  requiresLetter: true,
  area: "Москва",
  workFormat: "Удалённо",
  publishedAt: null,
  firstSeenAt: "2026-09-22T00:00:00Z",
  lastSeenAt: "2026-09-22T00:00:00Z",
  archived: false,
  dedupHash: "x",
};

describe("hh client offline flows", () => {
  it("detects login expiry and captcha as fatal blocks", async () => {
    const login = new FakeSession({ "https://hh.ru/applicant/resumes": { redirect: "https://hh.ru/account/login?role=applicant" } });
    expect(await client.checkLogin(login)).toBe(false);
    const captcha = new FakeSession({ "https://hh.ru/captcha": { text: "Подтвердите, что вы не робот" } });
    await captcha.goto("https://hh.ru/captcha");
    await expect(client.assertNotBlocked(captcha)).rejects.toMatchObject({ status: Status.FAILED_CAPTCHA });
  });

  it("reads vacancy state from the recorded InitialState fixture", async () => {
    const s = new FakeSession({ "https://hh.ru/vacancy/111": { html: fixture("vacancy.html") } });
    const result = await client.fetchVacancy(s, { externalId: "111", url: "https://hh.ru/vacancy/111", title: "", company: "", salaryRaw: "" });
    expect(result.alreadyApplied).toBe(false);
    expect(result.vacancy).toMatchObject({ externalId: "111", title: "Go разработчик", company: "ООО Ромашка", requiresLetter: true, hasTest: false, salaryFrom: 130500, salaryTo: 217500, currency: "RUR" });
    expect(result.vacancy.descriptionText).toContain("Go, PostgreSQL");
  });

  it("reads resumes from the applicant profile page state", async () => {
    const state = { latestResumeHash: "15be9ee5ff0fafa8950039ed1f5874374f7330", applicantResumes: [{ _attributes: { hash: "15be9ee5ff0fafa8950039ed1f5874374f7330", title: "Fullstack-разработчик" } }] };
    const html = `<template id="HH-Lux-InitialState">{"topLevelSite":"hh.ru"}</template><template style="display: none" class="ResumeProfileFront-InitialState">${JSON.stringify(state)}</template>`;
    const s = new FakeSession({ "https://hh.ru/applicant/resumes": { redirect: "https://hh.ru/applicant/profile/me", html } });
    expect(await client.syncResumes(s)).toMatchObject([{ hhResumeId: "15be9ee5ff0fafa8950039ed1f5874374f7330", title: "Fullstack-разработчик" }]);
  });

  it("reads a thread from hh.ru/chat (Chatik-InitialState)", async () => {
    const state = {
      userId: 162,
      chats: { chats: { items: [{ id: 9, lastMessage: { text: "чужой чат", participantId: "1" } }] } },
      chatData: {
        chat: {
          id: 5,
          resources: { VACANCY: ["137"] },
          messages: {
            items: [
              { id: 1, text: "", participantId: "162" },
              { id: 2, text: "Здравствуйте. Когда&nbsp;готовы выйти?", participantId: "894", participantDisplay: { isBot: false } },
              { id: 3, text: "Через две недели.", participantId: "162" },
            ],
          },
        },
        resources: { vacancies: { "137": { company: { name: "НПФ Сбербанка" } } } },
      },
    };
    const html = `<template id="HH-Lux-InitialState">{}</template><template class="Chatik-InitialState">${JSON.stringify(state)}</template>`;
    const s = new FakeSession({ "https://chatik.hh.ru/chat/5": { redirect: "https://hh.ru/chat/5", html } });
    const t = await client.readThread(s, "https://chatik.hh.ru/chat/5");
    expect(t.messages).toMatchObject([
      { hhMessageId: "2", direction: "in", author: "employer", isQuestion: true, text: "Здравствуйте. Когда готовы выйти?" },
      { hhMessageId: "3", direction: "out", author: "me" },
    ]);
    expect(t.vacancyExternalId).toBe("137");
    expect(t.thread.employer).toBe("НПФ Сбербанка");
  });

  it("marks rejections (DISCARD or wording) and whether the chat is writable", async () => {
    const page = (items: unknown[], allowed: boolean) =>
      `<template class="Chatik-InitialState">${JSON.stringify({ userId: 1, chatData: { chat: { id: 7, resources: {}, messages: { items } }, chatStates: { writeMessageState: { allowed } } } })}</template>`;
    const discard = new FakeSession({ "https://hh.ru/chat/7": { html: page([{ id: 1, text: "Спасибо за интерес.", participantId: "2", workflowTransition: { applicantState: "DISCARD" } }], false) } });
    const d = await client.readThread(discard, "https://hh.ru/chat/7");
    expect(d.thread.state).toBe("rejected");
    expect(d.writable).toBe(false);
    const byText = new FakeSession({ "https://hh.ru/chat/7": { html: page([{ id: 2, text: "К сожалению, на данном этапе мы не готовы пригласить вас.", participantId: "2" }], true) } });
    const t = await client.readThread(byText, "https://hh.ru/chat/7");
    expect(t.thread.state).toBe("rejected");
    expect(t.writable).toBe(true);
  });

  it("maps hh negotiation states, INTERVIEW counts as an invitation", () => {
    expect(["INVITATION", "INTERVIEW", "OFFER", "DISCARD", "RESPONSE"].map((x) => mapNegotiationState(x))).toEqual(["invited", "invited", "invited", "rejected", "new"]);
  });

  it("exposes quick-reply buttons of the chat bot's last question", async () => {
    const state = { userId: 1, chatData: { chat: { id: 8, resources: {}, messages: { items: [
      { id: 1, text: "Есть опыт с React Native?", participantId: "9", participantDisplay: { isBot: true }, actions: { text_buttons: [{ text: "Да, было на последнем месте работы" }, { text: "Был опыт разработки только веба" }] } },
    ] } }, chatStates: { writeMessageState: { allowed: true } } } };
    const s = new FakeSession({ "https://hh.ru/chat/8": { html: `<template class="Chatik-InitialState">${JSON.stringify(state)}</template>` } });
    const t = await client.readThread(s, "https://hh.ru/chat/8");
    expect(t.choices).toEqual(["Да, было на последнем месте работы", "Был опыт разработки только веба"]);
  });

  it("listThreads with `since` reads every page", async () => {
    const topic = (id: number, iso: string) => ({ id, chatId: id * 10, lastState: "RESPONSE", lastModifiedMillis: Date.parse(iso), vacancyId: 1, hasNewMessages: false });
    const page = (topics: unknown[]) => `<template id="HH-Lux-InitialState">${JSON.stringify({ applicantNegotiations: { topicList: topics, pageCount: 3 } })}</template>`;
    const s = new FakeSession({
      "https://hh.ru/applicant/negotiations": { html: page([topic(1, "2026-09-25T10:00:00Z"), topic(2, "2026-09-24T10:00:00Z")]) },
      "https://hh.ru/applicant/negotiations?page=1": { html: page([topic(3, "2026-09-23T10:00:00Z"), topic(4, "2026-09-20T10:00:00Z")]) },
      "https://hh.ru/applicant/negotiations?page=2": { html: page([topic(5, "2026-09-10T10:00:00Z")]) },
    });
    const ts = await client.listThreads(s, false, "2026-09-22T21:00:00.000Z");
    expect(ts.map((t) => t.negotiationId)).toEqual(["1", "2", "3", "4", "5"]); // all pages; the caller filters by date
  });

  it("dry-run opens the response form but never submits or sends chat", async () => {
    const s = new FakeSession(
      { "https://hh.ru/vacancy/111": { html: fixture("vacancy.html"), existing: ['[data-qa="vacancy-response-link-top"]', '[data-qa="resume-select-radio"]', '[data-qa="vacancy-response-questions"]'] } },
      { onExtract: () => ({ questions: [{ text: "Готовы?", kind: "radio", options: ["Да"], required: true }] }) },
    );
    const result = await client.apply(s, { vacancy, resumeTitle: "Go", coverLetter: "Здравствуйте.", allowOtherCountry: false, dryRun: true, answerQuestions: async () => [] });
    expect(result.status).toBe(Status.SKIP_DRY_RUN);
    expect(result.questions).toHaveLength(1);
    expect(s.methods()).toContain("click");
    expect(s.methods()).toContain("pressEscape");
    expect(s.calls.some((c) => c.method === "click" && String(c.args[0]).includes("submit"))).toBe(false);
    expect(s.calls.some((c) => c.method === "act" && /отправки|отправки отклика|сообщения/.test(String(c.args[0])))).toBe(false);
  });
});
