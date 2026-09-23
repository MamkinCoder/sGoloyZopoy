// chatsStage (src/runner/hh.ts) against a real in-memory store and a scripted hh chat.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile, Question, RunRequest, ThreadDetail } from "@sgz/shared";
import { openStore, type SqliteStore } from "../../src/db/index.js";
import { FakeLLM } from "../../src/llm/fake.js";
import { FEEDBACK_REQUEST, runHHUser } from "../../src/runner/hh.js";
import type { RunContext } from "../../src/runner/context.js";
import { planHH } from "../../src/runner/pipeline.js";
import { createStats } from "../../src/runner/stats.js";
import { fakeConfig } from "../api/fakes.js";

const profile = { full_name: "Y", email: "y@example.com", phone: "+7", directions: ["go"], never_claim_skills: [], exclude_words: [], company_blacklist: [] } as unknown as Profile;
type Msg = ThreadDetail["messages"][number];
const inMsg = (id: string, text: string): Msg => ({ hhMessageId: id, direction: "in", author: "employer", text, isQuestion: false, answered: false });
const outMsg = (id: string, text: string): Msg => ({ hhMessageId: id, direction: "out", author: "me", text, isQuestion: false, answered: false });

let store: SqliteStore;
afterEach(() => store?.close());

function setup() {
  store = openStore(":memory:");
  const user = store.upsertUser({ slug: "y", name: "Y", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
  store.saveProfile(user.id, profile);
  const page = { state: "RESPONSE", lastModified: "2026-09-24T10:00:00.000Z", rejected: false, messages: [] as Msg[], survey: [] as Question[], ext: null as string | null };
  const hh = {
    listThreads: vi.fn(async () => [{ negotiationId: "n1", chatUrl: "https://hh.ru/chat/1", unread: false, employer: "Acme", state: page.state, vacancyExternalId: null, lastModified: page.lastModified }]),
    readThread: vi.fn(async (): Promise<ThreadDetail> => ({
      thread: { hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Acme", state: page.rejected ? "rejected" : "new", lastSeenAt: "" },
      vacancyExternalId: page.ext,
      messages: page.messages,
      survey: page.survey,
      writable: true,
    })),
    sendMessage: vi.fn(async () => {}),
    fetchVacancy: vi.fn(async (_s: unknown, c: { externalId: string; url: string }) => ({
      alreadyApplied: false,
      vacancy: { source: "hh", externalId: c.externalId, url: c.url, title: "Frontend-разработчик (React)", company: "Acme", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "React, TypeScript", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "acme|frontend" },
    })),
    submitSurvey: vi.fn(async () => {}),
  } as unknown as RunContext["hh"] & { sendMessage: ReturnType<typeof vi.fn>; submitSurvey: ReturnType<typeof vi.fn>; fetchVacancy: ReturnType<typeof vi.fn> };
  const llm = new FakeLLM();
  const alert = vi.fn(async () => {});
  let clock = Date.parse("2026-09-25T10:00:00Z");
  const run = async (dryRun = false) => {
    clock += 3600_000;
    const req = { userSlug: "y", source: "hh", stage: "chats", dryRun, limit: 0, trigger: "manual" } as RunRequest;
    const ctx = {
      deps: { notifier: { alert } },
      cfg: fakeConfig("/tmp/sgz-chats-test"), store, hh, llm, req,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      run: { id: 1 },
      now: () => new Date(clock),
      checkAbort: () => {},
      throttle: { afterMutation: async () => {}, afterRead: async () => {} },
      browser: { openHH: vi.fn(async () => ({})), close: async () => {}, current: () => null },
      memoryGuard: async () => {},
      fileExists: () => false,
    } as unknown as RunContext;
    await runHHUser(ctx, { user, profile, stats: createStats(false) }, planHH("hh", "chats")!);
  };
  const thread = () => store.listChatThreads(user.id)[0]!;
  const alerts = (prefix: string) => alert.mock.calls.filter((c) => String((c as unknown[])[0]).startsWith(prefix));
  const feedbackSends = () => hh.sendMessage.mock.calls.filter((c) => (c as unknown[])[2] === FEEDBACK_REQUEST).length;
  return { page, hh, llm, run, thread, alerts, feedbackSends };
}

describe("chatsStage", () => {
  it("links an invitation's vacancy that was never stored, fetching it only once", async () => {
    const t = setup();
    t.page.state = "INVITATION";
    t.page.ext = "777";
    t.page.messages = [inMsg("1", "Приглашаем на собеседование")];
    await t.run();
    expect(t.hh.fetchVacancy).toHaveBeenCalledTimes(1);
    expect(t.thread().vacancyId).not.toBeNull();
    t.page.lastModified = "2026-09-26T10:00:00.000Z";
    await t.run();
    expect(t.hh.fetchVacancy).toHaveBeenCalledTimes(1);
  });

  it("a rejection on a needs_human thread asks for feedback once and the thread becomes rejected", async () => {
    const t = setup();
    t.page.messages = [inMsg("1", "Пришлём тестовое, выполните?")];
    t.llm.onAnswerChat = () => ({ reply: "Да, пришлите.", needs_human: true, reason: "test task" }) as never;
    await t.run();
    expect(t.thread().state).toBe("needs_human");
    t.page.rejected = true;
    t.page.messages = [...t.page.messages, inMsg("2", "Спасибо, но мы выбрали другого кандидата.")];
    t.page.lastModified = "2026-09-25T12:00:00.000Z";
    await t.run();
    t.page.lastModified = "2026-09-25T13:00:00.000Z"; // our feedback request moved it
    await t.run();
    expect(t.thread().state).toBe("rejected");
    expect(t.feedbackSends()).toBe(1);
  });

  it("an invited thread that needs a human stays invited and is not re-announced", async () => {
    const t = setup();
    t.page.state = "INVITATION";
    t.page.messages = [inMsg("1", "Приглашаем на собеседование, когда удобно?")];
    t.llm.onAnswerChat = () => ({ reply: "", needs_human: true, reason: "time" }) as never;
    await t.run();
    await t.run();
    expect(t.thread().state).toBe("invited");
    expect(t.alerts("🎉 Приглашение")).toHaveLength(1);
  });

  it("a dry run leaves state and messages alone, the real run still asks for feedback", async () => {
    const t = setup();
    t.page.messages = [inMsg("1", "Здравствуйте")];
    t.llm.onAnswerChat = () => ({ reply: "", needs_human: false, reason: "" }) as never;
    await t.run();
    t.page.rejected = true;
    t.page.messages = [...t.page.messages, inMsg("2", "К сожалению, мы не готовы пригласить вас.")];
    t.page.lastModified = "2026-09-25T12:00:00.000Z";
    await t.run(true);
    expect(t.thread().state).toBe("new");
    expect(store.listChatMessages(t.thread().id)).toHaveLength(1);
    expect(t.feedbackSends()).toBe(0);
    await t.run();
    expect(t.feedbackSends()).toBe(1);
  });

  it("a survey still in the chat state is submitted once", async () => {
    const t = setup();
    t.page.survey = [{ idx: 0, text: "Опыт с Go?", kind: "text", required: true }];
    await t.run();
    t.page.lastModified = "2026-09-25T12:00:00.000Z";
    await t.run();
    expect(t.hh.submitSurvey).toHaveBeenCalledTimes(1);
  });

  it("after a rejection only new employer messages are forwarded as feedback", async () => {
    const t = setup();
    t.page.rejected = true;
    t.page.messages = [inMsg("1", "К сожалению, мы выбрали другого кандидата.")];
    await t.run();
    t.page.messages = [...t.page.messages, outMsg("2", "А что не подошло?"), inMsg("3", "Не хватило опыта с Kafka.")];
    t.page.lastModified = "2026-09-25T12:00:00.000Z";
    await t.run();
    const fb = t.alerts("Фидбек");
    expect(fb).toHaveLength(1);
    expect(String((fb[0] as unknown[])[1])).toContain("Kafka");
    expect(String((fb[0] as unknown[])[1])).not.toContain("другого кандидата");
  });

  it("stores hh's send time as the message time", async () => {
    const t = setup();
    t.page.messages = [{ ...inMsg("1", "Завтра в 11 удобно?"), createdAt: "2026-09-24T20:50:00.000Z" }];
    await t.run();
    expect(store.listChatMessages(t.thread().id)[0]!.createdAt).toBe("2026-09-24T20:50:00.000Z");
  });
});
