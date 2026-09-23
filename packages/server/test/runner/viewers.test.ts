// viewersStage (src/runner/viewers.ts): warm leads from «Кто смотрел резюме» against a real in-memory store.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Status, type Card, type Profile, type RunRequest, type SearchParams } from "@sgz/shared";
import { openStore, type SqliteStore } from "../../src/db/index.js";
import { FakeLLM } from "../../src/llm/fake.js";
import type { RunContext } from "../../src/runner/context.js";
import { createRunCompanyTracker } from "../../src/runner/filters.js";
import { createStats } from "../../src/runner/stats.js";
import { viewersStage } from "../../src/runner/viewers.js";
import { fakeConfig } from "../api/fakes.js";

const profile = { full_name: "Y", email: "y@example.com", phone: "+7", directions: ["go"], hh_queries: ["go"], never_claim_skills: [], exclude_words: [], company_blacklist: [] } as unknown as Profile;

let store: SqliteStore;
afterEach(() => store?.close());

function setup(employers: string[]) {
  store = openStore(":memory:");
  const user = store.upsertUser({ slug: "y", name: "Y", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
  store.saveProfile(user.id, profile);
  const pool = [store.upsertHHResume({ userId: user.id, hhResumeId: "go1", title: "Go-разработчик", url: "https://hh.ru/resume/go1", direction: "go", summary: null, isGenerated: false, syncedAt: "" })];
  const cards = (id: string): Card[] => [1, 2].map((n) => ({ externalId: `${id}${n}`, url: `https://hh.ru/vacancy/${id}${n}`, title: `Go developer ${n}`, company: employers[Number(id) - 1]!, salaryRaw: "" }));
  const hh = {
    listResumeViewers: vi.fn(async () => employers.map((employer, i) => ({ employerId: String(i + 1), employer }))),
    search: vi.fn(async (_s: unknown, p: SearchParams) => cards(p.employerId!)),
    fetchVacancy: vi.fn(async (_s: unknown, c: Card) => ({
      vacancy: { source: "hh", externalId: c.externalId, url: c.url, title: c.title, company: c.company, salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "Go, Postgres", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: `${c.company}|${c.title}` },
      alreadyApplied: false,
    })),
    apply: vi.fn(async () => ({ status: Status.SENT, reasonDetail: "" })),
  };
  const alert = vi.fn(async () => {});
  let clock = Date.parse("2026-09-25T10:00:00Z");
  const run = async (budget = 10) => {
    clock += 7 * 3600_000;
    const ctx = {
      deps: { notifier: { alert } },
      cfg: fakeConfig("/tmp/sgz-viewers-test"), store, hh, llm: new FakeLLM(),
      req: { userSlug: "y", source: "hh", dryRun: false, limit: 0, trigger: "manual" } as RunRequest,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      run: { id: 1 },
      now: () => new Date(clock),
      checkAbort: () => {},
      throttle: { afterMutation: async () => {}, afterRead: async () => {} },
      browser: { openHH: vi.fn(async () => ({})), close: async () => {}, current: () => null },
      memoryGuard: async () => {},
    } as unknown as RunContext;
    return viewersStage(ctx, { user, profile, stats: createStats(false) }, pool, budget, createRunCompanyTracker());
  };
  const body = () => alert.mock.calls.map((c) => String((c as unknown[])[1])).join("\n");
  return { store, user, hh, alert, run, body };
}

describe("viewersStage", () => {
  it("applies to a new viewer once; the second run neither searches nor re-announces it", async () => {
    const t = setup(["Acme"]);
    expect(await t.run()).toBe(8);
    expect(t.hh.apply).toHaveBeenCalledTimes(2);
    expect(t.body()).toContain("Резюме смотрел Acme → откликнулся на «Go developer 1»");
    await t.run();
    expect(t.hh.search).toHaveBeenCalledTimes(1);
    expect(t.alert).toHaveBeenCalledTimes(1);
  });

  it("sends at most 3 per run; leads cut by the cap are kept for the next run", async () => {
    const t = setup(["Acme", "Beta", "Gamma"]);
    expect(await t.run()).toBe(7);
    expect(t.hh.apply).toHaveBeenCalledTimes(3);
    expect(t.body()).not.toContain("Gamma");
    await t.run();
    expect(t.hh.search).toHaveBeenCalledTimes(4); // only Gamma again
    expect(t.hh.apply).toHaveBeenCalledTimes(5);
    expect(t.body()).toContain("Резюме смотрел Gamma → откликнулся");
  });

  it("skips an employer already applied to (it is reading that application) and says nothing", async () => {
    const t = setup(["ООО Acme"]);
    const v = t.store.upsertVacancy({ source: "hh", externalId: "old", url: "https://hh.ru/vacancy/old", title: "Backend", company: "Acme", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "acme|backend" });
    t.store.insertApplication({ userId: t.user.id, vacancyId: v.id, hhResumeId: null, generatedResumeId: null, runId: 0, status: Status.SENT, reasonDetail: "", coverLetter: "", llmDecision: null, direction: "" });
    expect(await t.run()).toBe(10);
    expect(t.hh.search).not.toHaveBeenCalled();
    expect(t.alert).not.toHaveBeenCalled();
  });

  it("does nothing when turned off or when nobody looked", async () => {
    const t = setup([]);
    await t.run();
    expect(t.alert).not.toHaveBeenCalled();
    t.store.setSetting("viewers_enabled", "0");
    await t.run();
    expect(t.hh.listResumeViewers).toHaveBeenCalledTimes(1);
  });
});
