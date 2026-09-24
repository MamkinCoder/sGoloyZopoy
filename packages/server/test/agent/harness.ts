// The always-on agent's chat jobs against a real in-memory store, a scripted hh chat page, FakeLLM and a
// recording notifier. `drain()` runs every due job to the end; the clock only moves with `advance()`.
import { vi } from "vitest";
import type { Profile, Question, TgButton, ThreadDetail } from "@sgz/shared";
import type { ChatEnv } from "../../src/agent/chats/env.js";
import { chatHandlers } from "../../src/agent/chats/index.js";
import { kbReviewGate, onKbTap, parseKbCallback } from "../../src/agent/chats/review.js";
import { addStories, type KbStoryDraft } from "../../src/kb/write.js";
import { createAgent } from "../../src/agent/queue.js";
import { openStore } from "../../src/db/index.js";
import type { HabrClient } from "../../src/habr/client.js";
import { FakeLLM } from "../../src/llm/fake.js";
import { fakeConfig } from "../api/fakes.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sgz/shared";

type Msg = ThreadDetail["messages"][number];
export const inMsg = (id: string, text: string): Msg => ({ hhMessageId: id, direction: "in", author: "employer", text, isQuestion: false, answered: false });
export const TG_CHAT = "42";
export const outMsg = (id: string, text: string): Msg => ({ hhMessageId: id, direction: "out", author: "me", text, isQuestion: false, answered: false });

export const baseProfile = {
  full_name: "Y",
  email: "y@example.com",
  phone: "+7",
  summary: "Go backend",
  directions: ["go"],
  verified_skills: ["Go", "React"],
  never_claim_skills: ["Kafka"],
  hh_queries: ["go"],
  exclude_words: [],
  company_blacklist: [],
  extra: {},
} as unknown as Profile;

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function chatHarness(o: { habr?: HabrClient | null } = {}) {
  const store = openStore(":memory:");
  const user = store.upsertUser({ slug: "y", name: "Y", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
  store.saveProfile(user.id, baseProfile);
  // A Habr client in the test means the user set Habr up: chats.sync only reads Habr with a saved login.
  const cfg = fakeConfig(mkdtempSync(join(tmpdir(), "sgz-agent-"))); // per harness: test files run in parallel
  if (o.habr) {
    const habrCookies = paths.habrCookies(cfg, "y");
    mkdirSync(dirname(habrCookies), { recursive: true });
    writeFileSync(habrCookies, "[]");
  }
  let clock = Date.parse("2026-09-25T10:00:00Z");
  const now = () => new Date(clock);
  let sent = 0;
  const page = {
    state: "RESPONSE",
    lastModified: "2026-09-24T10:00:00.000Z",
    rejected: false,
    messages: [] as Msg[],
    survey: [] as Question[],
    ext: null as string | null,
    writable: true,
    choices: [] as string[],
    /** The next sendMessage puts the message on the page, then throws (a confirm timeout). */
    failAfterSend: false,
  };
  const hh = {
    listThreads: vi.fn(async () => [{ negotiationId: "n1", chatUrl: "https://hh.ru/chat/1", unread: false, employer: "Acme", state: page.state, vacancyExternalId: null, lastModified: page.lastModified }]),
    readThread: vi.fn(
      async (): Promise<ThreadDetail> => ({
        thread: { hhNegotiationId: "n1", isBot: false, vacancyId: null, employer: "Acme", state: page.rejected ? "rejected" : "new", lastSeenAt: "" },
        vacancyExternalId: page.ext,
        messages: page.messages.map((m) => ({ ...m })),
        survey: page.survey,
        writable: page.writable,
        ...(page.choices.length ? { choices: page.choices } : {}),
      }),
    ),
    sendMessage: vi.fn(async (_s: unknown, _url: string, text: string) => {
      page.messages.push(outMsg(`o${++sent}`, text));
      page.lastModified = new Date(clock).toISOString();
      if (page.failAfterSend) {
        page.failAfterSend = false;
        throw new Error("sendMessage: the sent message did not appear in the thread");
      }
    }),
    fetchVacancy: vi.fn(async (_s: unknown, c: { externalId: string; url: string }) => ({
      alreadyApplied: false,
      vacancy: { source: "hh", externalId: c.externalId, url: c.url, title: "Frontend-разработчик (React)", company: "Acme", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "React, TypeScript", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "acme|frontend" },
    })),
    submitSurvey: vi.fn(async () => {}),
  };
  const llm = new FakeLLM();
  const asks: { text: string; buttons: TgButton[][] }[] = [];
  const notifier = {
    report: async () => undefined,
    alert: vi.fn(async (_t: string, _b: string) => undefined),
    ask: vi.fn(async (text: string, b: TgButton[] | TgButton[][]) => {
      asks.push({ text, buttons: (Array.isArray(b[0]) ? b : [b]) as TgButton[][] });
      return 1000 + asks.length;
    }),
    edit: vi.fn(async (_id: number, _text: string, _b: TgButton[][]) => undefined),
  };
  let agent: ReturnType<typeof createAgent> | null = null;
  const env: ChatEnv = {
    cfg,
    store,
    hh: hh as unknown as ChatEnv["hh"],
    habr: o.habr ?? null,
    llm,
    notifier,
    log: silent,
    now,
    throttle: { afterMutation: async () => {}, afterRead: async () => {} },
    browser: { openHH: async () => ({}) as never, openHabr: async () => ({}) as never },
    enqueue: (kind, payload, opts) => agent!.enqueue(kind, payload, opts),
    review: kbReviewGate(store, notifier, now),
  };
  agent = createAgent({ store, handlers: chatHandlers(env), notifier, now, log: silent, browserIdleMs: 60_000 });

  /** Every due job, until none is left (jobs enqueue more jobs). */
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      agent!.tick();
      await agent!.settle();
      if (!store.dueJobs(now().toISOString(), 1).length) return;
    }
    throw new Error("drain: jobs never settle");
  };
  const sync = async () => {
    agent!.enqueue("chats.sync", {}, { key: "chats.sync" });
    await drain();
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  const thread = () => store.listChatThreads(user.id)[0]!;
  const tasks = () => store.db.prepare("SELECT id FROM chat_tasks ORDER BY id").all().map((r) => store.getChatTask(Number(r.id))!);
  const alerts = (prefix: string) => notifier.alert.mock.calls.filter((c) => String(c[0]).startsWith(prefix));
  const sends = (text?: string) => hh.sendMessage.mock.calls.filter((c) => text === undefined || c[2] === text).length;
  /** A KB story (seed, unconfirmed) linked to `tag`. */
  const story = (tag: string, o: Partial<KbStoryDraft> = {}) =>
    addStories(store, user.id, [{ title: `${tag} в проде`, company: "Яндекс", period: "2022-2024", context: "", did: `Писал на ${tag}.`, result: "", tags: [tag], ...o }], { source: "seed", confirmed: false }).added[0]!;
  /** Taps a button of a card (the latest by default) by its label. */
  const tap = (label: string, card = asks.at(-1)!) => {
    const b = card.buttons.flat().find((x) => x.text === label);
    if (!b) throw new Error(`no button ${label} in ${card.buttons.flat().map((x) => x.text).join(", ")}`);
    const kr = parseKbCallback(b.data);
    if (!kr) throw new Error(`not a KB button: ${b.data}`);
    return onKbTap(env, kr, TG_CHAT);
  };
  const labels = (card = asks.at(-1)!) => card.buttons.map((row) => row.map((b) => b.text));
  return { store, user, page, hh, llm, notifier, asks, env, agent, drain, sync, advance, thread, tasks, alerts, sends, now, story, tap, labels };
}
