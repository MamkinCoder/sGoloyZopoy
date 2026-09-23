// force:<id>: a human overrides a filter/reject from the panel ("Всё равно откликнуться"). Covers
// runHHUser's forceApply path (src/runner/hh.ts) reached via planHH("hh", "force:<id>").
import { describe, expect, it, vi } from "vitest";
import { Status, type HHResume, type Profile, type RunRequest, type Vacancy } from "@sgz/shared";
import { FakeLLM } from "../../src/llm/fake.js";
import { runHHUser } from "../../src/runner/hh.js";
import type { RunContext } from "../../src/runner/context.js";
import { syncKey } from "../../src/runner/pool.js";
import { planHH } from "../../src/runner/pipeline.js";
import { createStats } from "../../src/runner/stats.js";
import { FakeStore, fakeConfig } from "../api/fakes.js";

const profile = { full_name: "Ярослав Белов", email: "y@example.com", phone: "+7", directions: ["go"], never_claim_skills: [], exclude_words: [], company_blacklist: [] } as unknown as Profile;

function setup() {
  const store = new FakeStore();
  const cfg = fakeConfig("/tmp/sgz-hh-force-test");
  const user = store.upsertUser({ slug: "y", name: "Y", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
  store.saveProfile(user.id, profile);
  const resumePool: HHResume = store.upsertHHResume({ userId: user.id, hhResumeId: "go1", title: "Go-разработчик", url: "https://hh.ru/resume/go1", direction: "go", summary: null, isGenerated: false, syncedAt: "" });
  // poolSync is "auto" on the force plan; mark the pool fresh so forceApply's own logic is what's under test.
  store.setSetting(syncKey(user.slug), new Date("2026-09-23T10:00:00Z").toISOString());

  const vacancy = store.upsertVacancy({
    source: "hh", externalId: "ext-1", url: "https://hh.ru/vacancy/1", title: "Go developer", company: "Acme",
    salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "Go, Postgres", hasTest: false, requiresLetter: false,
    area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "acme|go developer",
  } as Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt">);

  const applyResult = { status: Status.SENT, reasonDetail: "" };
  const apply = vi.fn(async (_s: unknown, req: { answerQuestions: (qs: never[]) => Promise<unknown> }) => {
    await req.answerQuestions([]);
    return applyResult;
  });
  const fetchVacancy = vi.fn(async () => ({ vacancy: { ...vacancy, descriptionText: "Go, Postgres" }, alreadyApplied: false }));
  const hh = { apply, fetchVacancy } as unknown as RunContext["hh"];

  const llm = new FakeLLM();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const run = async (stage: string) => {
    const req = { userSlug: "y", source: "hh", stage, dryRun: false, limit: 0, trigger: "manual" } as RunRequest;
    const ctx = {
      deps: {},
      cfg, store, hh, llm, log, req,
      run: { id: 1 },
      now: () => new Date("2026-09-23T10:00:00Z"),
      checkAbort: () => {},
      throttle: { afterMutation: async () => {}, afterRead: async () => {} },
      browser: { openHH: vi.fn(async () => ({})), close: async () => {}, current: () => null },
      memoryGuard: async () => {},
      fileExists: () => false,
    } as unknown as RunContext;
    const stats = createStats(false);
    const plan = planHH("hh", stage)!;
    await runHHUser(ctx, { user, profile, stats }, plan);
    return stats.snapshot();
  };

  return { store, user, vacancy, resumePool, apply, fetchVacancy, llm, log, run };
}

describe("hh force apply", () => {
  it("SKIP_FILTER vacancy: decide still runs, applies with the decided resume+letter, records SENT with a 'forced by user' reason", async () => {
    const t = setup();
    const rejected = t.store.insertApplication({
      userId: t.user.id, vacancyId: t.vacancy.id, hhResumeId: null, generatedResumeId: null, runId: 0,
      status: Status.SKIP_FILTER, reasonDetail: "exclude word", coverLetter: "", llmDecision: null, direction: "",
    });
    t.llm.onDecide = (input) => input.vacancies.map((v) => ({
      vacancy_id: v.id, apply: false, reason: "senior only", resume_id: "go1", cover_letter: "Здравствуйте! Готов обсудить детали.", direction: "go", seniority: "middle", red_flags: [],
    }));

    await t.run(`force:${rejected.id}`);

    expect(t.llm.calls.filter((c) => c.method === "decide")).toHaveLength(1);
    expect(t.apply).toHaveBeenCalledTimes(1);
    const [, req] = t.apply.mock.calls[0]!;
    expect(req).toMatchObject({ resumeTitle: "Go-разработчик", coverLetter: "Здравствуйте! Готов обсудить детали." });

    const sent = t.store.applications.at(-1)!;
    expect(sent).toMatchObject({
      status: Status.SENT,
      llmDecision: expect.objectContaining({ apply: true, reason: expect.stringContaining("forced by user (was SKIP_FILTER: exclude word)") }),
    });
  });

  it("already sent: nothing is applied", async () => {
    const t = setup();
    const app = t.store.insertApplication({
      userId: t.user.id, vacancyId: t.vacancy.id, hhResumeId: null, generatedResumeId: null, runId: 0,
      status: Status.SKIP_FILTER, reasonDetail: "exclude word", coverLetter: "", llmDecision: null, direction: "",
    });
    t.store.insertApplication({
      userId: t.user.id, vacancyId: t.vacancy.id, hhResumeId: null, generatedResumeId: null, runId: 0,
      status: Status.SENT, reasonDetail: "", coverLetter: "", llmDecision: null, direction: "",
    });
    const before = t.store.applications.length;

    await t.run(`force:${app.id}`);

    expect(t.apply).not.toHaveBeenCalled();
    expect(t.llm.calls.filter((c) => c.method === "decide")).toHaveLength(0);
    expect(t.store.applications).toHaveLength(before);
    expect(t.log.warn).toHaveBeenCalledWith("apply", expect.stringContaining("already sent"));
  });

  it("no descriptionText, fetch reports alreadyApplied: records SKIP_ALREADY_APPLIED, no apply", async () => {
    const t = setup();
    const bare = t.store.upsertVacancy({
      source: "hh", externalId: "ext-2", url: "https://hh.ru/vacancy/2", title: "Backend developer", company: "Beta",
      salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "", hasTest: false, requiresLetter: false,
      area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "beta|backend developer",
    } as Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt">);
    const app = t.store.insertApplication({
      userId: t.user.id, vacancyId: bare.id, hhResumeId: null, generatedResumeId: null, runId: 0,
      status: Status.SKIP_FILTER, reasonDetail: "exclude word", coverLetter: "", llmDecision: null, direction: "",
    });
    t.fetchVacancy.mockResolvedValueOnce({ vacancy: { ...bare, descriptionText: "" }, alreadyApplied: true });

    await t.run(`force:${app.id}`);

    expect(t.fetchVacancy).toHaveBeenCalledTimes(1);
    expect(t.apply).not.toHaveBeenCalled();
    expect(t.llm.calls.filter((c) => c.method === "decide")).toHaveLength(0);
    const recorded = t.store.applications.at(-1)!;
    expect(recorded).toMatchObject({ vacancyId: bare.id, status: Status.SKIP_ALREADY_APPLIED, reasonDetail: "forced by user" });
  });

  it("application belongs to another user: logs an error and applies nothing", async () => {
    const t = setup();
    const other = t.store.upsertUser({ slug: "other", name: "Other", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
    const app = t.store.insertApplication({
      userId: other.id, vacancyId: t.vacancy.id, hhResumeId: null, generatedResumeId: null, runId: 0,
      status: Status.SKIP_FILTER, reasonDetail: "exclude word", coverLetter: "", llmDecision: null, direction: "",
    });
    const before = t.store.applications.length;

    await t.run(`force:${app.id}`);

    expect(t.apply).not.toHaveBeenCalled();
    expect(t.log.error).toHaveBeenCalledWith("apply", expect.stringContaining(`hh application ${app.id} not found for y`));
    expect(t.store.applications).toHaveLength(before);
  });

  it("non-hh source application: logs an error and applies nothing", async () => {
    const t = setup();
    const careerVacancy = t.store.upsertVacancy({
      source: "career", externalId: "ext-3", url: "https://acme.test/job/1", title: "Go developer", company: "Acme",
      salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "Go", hasTest: false, requiresLetter: false,
      area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "acme|go developer career",
    } as Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt">);
    const app = t.store.insertApplication({
      userId: t.user.id, vacancyId: careerVacancy.id, hhResumeId: null, generatedResumeId: null, runId: 0,
      status: Status.SKIP_FILTER, reasonDetail: "exclude word", coverLetter: "", llmDecision: null, direction: "",
    });
    const before = t.store.applications.length;

    await t.run(`force:${app.id}`);

    expect(t.apply).not.toHaveBeenCalled();
    expect(t.log.error).toHaveBeenCalledWith("apply", expect.stringContaining(`hh application ${app.id} not found for y`));
    expect(t.store.applications).toHaveLength(before);
  });
});
