// Habr runner (src/runner/habr.ts) against a real in-memory store and a fake Habr client: plans, the daily
// limit, cross-source dedup with hh and the response allowance stop. Habr chats: test/agent/chats-sync.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Status, normalizeDedup, type Profile, type RunRequest } from "@sgz/shared";
import { openStore, type SqliteStore } from "../../src/db/index.js";
import type { HabrClient } from "../../src/habr/client.js";
import type { HabrCard, HabrConversation, HabrMessage, HabrVacancyState } from "../../src/habr/state.js";
import { FakeLLM } from "../../src/llm/fake.js";
import type { RunContext } from "../../src/runner/context.js";
import { runHabrUser, type HabrPlan } from "../../src/runner/habr.js";
import { planCareer, planHH, planHabr } from "../../src/runner/pipeline.js";
import { createStats } from "../../src/runner/stats.js";
import { fakeConfig } from "../api/fakes.js";

const profile = {
  full_name: "Y",
  email: "y@example.com",
  phone: "+7",
  summary: "Go backend",
  directions: ["go-backend"],
  verified_skills: ["Go"],
  hh_queries: ["go"],
  never_claim_skills: [],
  exclude_words: ["lead"],
  company_blacklist: [],
  extra: {},
} as unknown as Profile;

let store: SqliteStore;
afterEach(() => store?.close());

const state = (id: string, title: string, company: string, over: Partial<HabrVacancyState> = {}): HabrVacancyState => ({
  externalId: id,
  title,
  company,
  salaryFrom: 0,
  salaryTo: 0,
  currency: "",
  descriptionText: "Go, PostgreSQL",
  area: "",
  workFormat: "",
  publishedAt: null,
  archived: false,
  kind: "direct",
  responded: false,
  responseMessage: "",
  responsesLeft: 100,
  placeholder: "",
  login: "me",
  ...over,
});

function setup(cards: HabrCard[], opts: { left?: (n: number) => number; states?: Record<string, Partial<HabrVacancyState>>; conversations?: HabrConversation[]; messages?: HabrMessage[] } = {}) {
  store = openStore(":memory:");
  const user = store.upsertUser({ slug: "y", name: "Y", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
  store.saveProfile(user.id, profile);
  let applied = 0;
  const habr = {
    checkLogin: vi.fn(async () => true),
    search: vi.fn(async (_s: unknown, _q: string, page: number) => ({ cards: page === 0 ? cards : [], totalPages: 1 })),
    fetchVacancy: vi.fn(async (_s: unknown, c: { externalId: string; url: string; title: string; company: string }) => {
      const st = state(c.externalId, c.title, c.company, opts.states?.[c.externalId]);
      return {
        vacancy: { source: "habr", externalId: c.externalId, url: c.url, title: c.title, company: c.company, salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: st.descriptionText, hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: normalizeDedup(c.company, c.title) },
        state: st,
      };
    }),
    apply: vi.fn(async () => {
      applied++;
      return { status: Status.SENT, reasonDetail: "sent with letter", responsesLeft: opts.left ? opts.left(applied) : 100 };
    }),
    listConversations: vi.fn(async () => ({ conversations: opts.conversations ?? [], myAvatar: "me.jpg" })),
    readConversation: vi.fn(async () => ({ messages: opts.messages ?? [], writable: true })),
    sendMessage: vi.fn(async () => {}),
  } satisfies HabrClient;
  const alert = vi.fn(async () => {});
  const llm = new FakeLLM();
  const run = (plan: Partial<HabrPlan> = {}, req: Partial<RunRequest> = {}) => {
    const ctx = {
      deps: { habr, notifier: { alert } },
      cfg: fakeConfig("/tmp/sgz-habr-test"),
      store,
      llm,
      req: { userSlug: "y", source: "habr", dryRun: false, limit: 0, trigger: "manual", ...req } as RunRequest,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      run: { id: 1 },
      now: () => new Date("2026-09-24T10:00:00Z"),
      checkAbort: () => {},
      throttle: { afterMutation: async () => {}, afterRead: async () => {} },
      browser: { openHabr: vi.fn(async () => ({})), close: async () => {} },
      memoryGuard: async () => {},
    } as unknown as RunContext;
    return runHabrUser(ctx, { user, profile, stats: createStats(false) }, { search: true, decide: true, apply: true, force: null, ...plan });
  };
  const statuses = () => store.listApplications({ userId: user.id, page: 1, pageSize: 100 }).items.map((r) => `${r.vacancy.externalId}:${r.application.status}`).sort();
  return { user, habr, alert, run, statuses, llm };
}

const card = (id: string, title = `Go developer ${id}`, company = `Co${id}`, alreadyApplied = false): HabrCard => ({ externalId: id, url: `https://career.habr.com/vacancies/${id}`, title, company, salaryRaw: "", alreadyApplied });

describe("habr run planning", () => {
  it("runs as its own source and inside all, never inside hh or career", () => {
    expect(planHabr("habr", undefined)).toEqual({ search: true, decide: true, apply: true, force: null });
    expect(planHabr("all", undefined)).toMatchObject({ search: true, apply: true });
    expect(planHabr("habr", "decide")).toMatchObject({ search: true, decide: true, apply: false });
    expect(planHabr("habr", "force:7")).toMatchObject({ force: 7, search: false });
    expect(planHabr("all", "force:7")).toBeNull();
    expect(planHabr("hh", undefined)).toBeNull();
    expect(planHabr("career", undefined)).toBeNull();
    expect(planHabr("all", "rotate")).toBeNull();
    expect(planHH("habr", undefined)).toBeNull();
    expect(planCareer("habr", undefined)).toBeNull();
  });
});

describe("runHabrUser", () => {
  it("applies with the decide letter up to habr_daily_limit", async () => {
    const t = setup([card("1"), card("2"), card("3")]);
    store.setSetting("habr_daily_limit", "2");
    await t.run();
    expect(t.habr.apply).toHaveBeenCalledTimes(2);
    const req = t.habr.apply.mock.calls[0] as unknown as [unknown, { coverLetter: string; dryRun: boolean }];
    expect(req[1].coverLetter).toContain("Откликаюсь на вакансию");
    expect(t.statuses()).toEqual(["1:SENT", "2:SENT", "3:SKIP_LIMIT"]);
    await t.run(); // the day's budget is spent: no search at all
    expect(t.habr.search).toHaveBeenCalledTimes(1);
  });

  it("skips a job already sent on hh (same company + title) and one Habr marks as responded", async () => {
    const t = setup([card("1", "Go-разработчик", "ООО Acme"), card("2", "Go developer 2", "Beta", true), card("3")]);
    const hh = store.upsertVacancy({ source: "hh", externalId: "777", url: "https://hh.ru/vacancy/777", title: "Go-разработчик", company: "Acme", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: normalizeDedup("Acme", "Go-разработчик") });
    store.insertApplication({ userId: t.user.id, vacancyId: hh.id, hhResumeId: null, generatedResumeId: null, runId: 0, status: Status.SENT, reasonDetail: "", coverLetter: "", llmDecision: null, direction: "" });
    await t.run();
    expect(t.habr.fetchVacancy.mock.calls.map((c) => (c[1] as { externalId: string }).externalId)).toEqual(["3"]);
    expect(t.statuses()).toEqual(["1:SKIP_DEDUP", "2:SKIP_ALREADY_APPLIED", "3:SENT", "777:SENT"]);
  });

  it("does not apply to external-apply vacancies and stops when the response allowance runs low", async () => {
    const t = setup([card("1"), card("2"), card("3"), card("4")], { states: { "1": { kind: "external" } }, left: (n) => (n >= 2 ? 9 : 50) });
    await t.run();
    expect(t.habr.apply).toHaveBeenCalledTimes(2); // 2 → 9 left: stop before 4
    expect(t.statuses()).toEqual(["1:SKIP_FILTER", "2:SENT", "3:SENT"]);
    expect(t.alert).toHaveBeenCalledTimes(1);
    expect(String((t.alert.mock.calls[0] as unknown[])[0])).toContain("отклики заканчиваются");
  });

  it("dry run applies nothing for real and keeps the budget", async () => {
    const t = setup([card("1")]);
    t.habr.apply.mockImplementation(async () => ({ status: Status.SKIP_DRY_RUN, reasonDetail: "dry run", responsesLeft: 100 }));
    await t.run({}, { dryRun: true });
    expect((t.habr.apply.mock.calls[0] as unknown as [unknown, { dryRun: boolean }])[1].dryRun).toBe(true);
    expect(t.statuses()).toEqual(["1:SKIP_DRY_RUN"]);
  });
});
