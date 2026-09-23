// Career sites never auto-submit: a run queues (QUEUED), stage send:/inspect:/force: act on one row.
import { describe, expect, it, vi } from "vitest";
import { Status, type CareerAgent, type CareerApplyRequest, type Profile, type RunRequest } from "@sgz/shared";
import { FakeLLM } from "../../src/llm/fake.js";
import { careerRotation, runCareerUser } from "../../src/runner/career.js";
import type { RunContext } from "../../src/runner/context.js";
import { planCareer } from "../../src/runner/pipeline.js";
import { createStats } from "../../src/runner/stats.js";
import { FakeStore, fakeConfig } from "../api/fakes.js";

const profile = { full_name: "Ярослав Белов", email: "y@example.com", phone: "+7", directions: ["go"], never_claim_skills: [], exclude_words: [], company_blacklist: [] } as unknown as Profile;

function setup(applyResult: { status: Status; reasonDetail: string; questions?: never[] } = { status: Status.SENT, reasonDetail: "confirmed" }) {
  const store = new FakeStore();
  const cfg = fakeConfig("/tmp/sgz-career-queue-test");
  const user = store.upsertUser({ slug: "y", name: "Y", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
  store.saveProfile(user.id, profile);
  const site = store.upsertCareerSite({ userId: user.id, slug: "acme", name: "Acme", baseUrl: "https://acme.test", ats: "greenhouse", profile: { listing_url: "https://acme.test/jobs" }, enabled: true, lastRunAt: null } as never);
  const apply = vi.fn(async (_s: unknown, req: CareerApplyRequest) => {
    await req.answerQuestions([{ idx: 0, text: "Опыт с Go?", kind: "text", required: true }]);
    return applyResult;
  });
  const career = {
    onboard: vi.fn(),
    discover: vi.fn(async () => [{ externalId: "job-1", url: "https://acme.test/job/1", title: "Go developer", company: "Acme" }]),
    fetch: vi.fn(async () => ({
      source: "acme", externalId: "job-1", url: "https://acme.test/job/1", title: "Go developer", company: "Acme", salaryFrom: 0, salaryTo: 0, currency: "",
      descriptionText: "Go, Postgres", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "acme|go developer",
    })),
    apply,
  } as unknown as CareerAgent;
  const resume = {
    loadCV: vi.fn(async () => ({ title: "Go" }) as never),
    renderTex: () => "tex",
    buildPdf: vi.fn(async (o: { outPdf: string }) => ({ pdfPath: o.outPdf, texPath: o.outPdf.replace(".pdf", ".tex") })),
    validateCV: () => [],
  };
  const llm = new FakeLLM();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = async (stage?: string, dryRun = false) => {
    const req = { userSlug: "y", source: "career", stage, dryRun, limit: 0, trigger: "manual" } as RunRequest;
    const ctx = {
      deps: { career, resume }, cfg, store, llm, log, req,
      run: { id: 1 },
      now: () => new Date(),
      checkAbort: () => {},
      throttle: { afterMutation: async () => {}, afterRead: async () => {} },
      browser: { open: vi.fn(async () => ({})), close: async () => {}, current: () => null },
      memoryGuard: async () => {},
      fileExists: (p: string) => p.endsWith("base-go.yaml"),
    } as unknown as RunContext;
    const stats = createStats(dryRun);
    await runCareerUser(ctx, { user, profile, stats }, planCareer("career", stage)!);
    return stats.snapshot();
  };
  return { store, site, apply, llm, run, user };
}

describe("career review queue", () => {
  it("retailor:<id> queues a fresh CV + letter and retires the old row without using a queue slot", async () => {
    const t = setup();
    await t.run();
    const old = t.store.applications[0]!;
    await t.run(`retailor:${old.id}`);
    expect(t.apply).not.toHaveBeenCalled();
    const rows = t.store.applications;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: old.id, status: Status.SKIP_DEDUP });
    expect(rows[1]).toMatchObject({ status: Status.QUEUED, vacancyId: old.vacancyId });
    expect(rows[1]!.generatedResumeId).not.toBe(old.generatedResumeId);
  });

  it("rotate: visits only sites not visited today, stops once the daily budget is used", async () => {
    const t = setup();
    await t.run("rotate");
    expect(t.store.applications.map((a) => a.status)).toEqual([Status.QUEUED]);
    expect(careerRotation(t.store, t.user, "Europe/Moscow", new Date()).sites).toEqual([]); // acme visited today
    await t.run("rotate");
    expect(t.store.applications).toHaveLength(1);
    t.store.upsertUser({ ...t.user, dailyLimitCareer: 0 });
    t.store.upsertCareerSite({ ...t.site, lastRunAt: null });
    expect(careerRotation(t.store, t.store.getUserBySlug("y")!, "Europe/Moscow", new Date())).toMatchObject({ budget: 0 });
  });

  it("a normal run queues the tailored CV + letter and never calls career.apply", async () => {
    const t = setup();
    const stats = await t.run();
    expect(t.apply).not.toHaveBeenCalled();
    const [app] = t.store.applications;
    expect(app).toMatchObject({ status: Status.QUEUED, direction: "go", llmDecision: expect.objectContaining({ reason: "fake: подходит" }) });
    expect(app!.coverLetter).toContain("Go developer");
    expect(t.store.getGeneratedResume(app!.generatedResumeId!)?.pdfPath).toMatch(/generated\/\d+\.pdf$/);
    expect(stats.by_status).toEqual({ QUEUED: 1 });

    // the next run must not queue the same vacancy again
    await t.run();
    expect(t.store.applications).toHaveLength(1);
  });

  it("send:<id> submits with the (edited) letter and records the result on that row", async () => {
    const t = setup();
    await t.run();
    const id = t.store.applications[0]!.id;
    t.store.updateApplicationCoverLetter(id, "Отредактировано.");
    await t.run(`send:${id}`);
    expect(t.apply).toHaveBeenCalledTimes(1);
    expect(t.apply.mock.calls[0]![1]).toMatchObject({ dryRun: false, coverLetter: "Отредактировано.", resumePdfPath: expect.stringMatching(/\.pdf$/) });
    expect(t.store.applications).toHaveLength(1);
    expect(t.store.applications[0]).toMatchObject({ status: Status.SENT, reasonDetail: "confirmed" });
    expect(t.store.listQuestionnaireAnswers(id)).toHaveLength(1);
    await t.run(`send:${id}`); // not queued anymore → no second submit
    expect(t.apply).toHaveBeenCalledTimes(1);
  });

  it("inspect:<id> fills without submitting, stores questions + answers and stays QUEUED", async () => {
    const t = setup({ status: Status.SKIP_DRY_RUN, reasonDetail: "dry run" });
    await t.run();
    const id = t.store.applications[0]!.id;
    await t.run(`inspect:${id}`);
    await t.run(`inspect:${id}`);
    expect(t.apply.mock.calls[0]![1]).toMatchObject({ dryRun: true });
    expect(t.store.applications[0]).toMatchObject({ status: Status.QUEUED, reasonDetail: expect.stringContaining("form checked: 1 question") });
    expect(t.store.listQuestionnaireAnswers(id)).toEqual([expect.objectContaining({ question: expect.objectContaining({ text: "Опыт с Go?" }), answer: { idx: 0, text: "fake answer" } })]);
  });

  it("force:<id> skips filters + decide and queues a filtered vacancy", async () => {
    const t = setup();
    t.llm.onDecide = (input) => input.vacancies.map((v) => ({ vacancy_id: v.id, apply: false, reason: "senior only", resume_id: "", cover_letter: "", direction: "", seniority: "", red_flags: [] }));
    await t.run();
    const rejected = t.store.applications[0]!;
    expect(rejected.status).toBe(Status.SKIP_LLM_REJECT);
    const decides = t.llm.calls.filter((c) => c.method === "decide").length;
    await t.run(`force:${rejected.id}`);
    expect(t.llm.calls.filter((c) => c.method === "decide")).toHaveLength(decides);
    expect(t.apply).not.toHaveBeenCalled();
    expect(t.store.applications.at(-1)).toMatchObject({ vacancyId: rejected.vacancyId, status: Status.QUEUED, llmDecision: expect.objectContaining({ apply: true, reason: expect.stringContaining("forced by user (was SKIP_LLM_REJECT: senior only)") }) });
  });
});
