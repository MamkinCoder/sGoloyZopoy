// Career sites never auto-submit: a run queues (QUEUED), stage send:/inspect:/force: act on one row.
import { describe, expect, it, vi } from "vitest";
import { Status, type CareerAgent, type CareerApplyRequest, type Profile, type RunRequest } from "@sgz/shared";
import { FakeLLM } from "../../src/llm/fake.js";
import { careerRotation, rotationScore, runCareerUser, siteFails } from "../../src/runner/career.js";
import type { RunContext } from "../../src/runner/context.js";
import { planCareer } from "../../src/runner/pipeline.js";
import { createStats } from "../../src/runner/stats.js";
import { RunStoppedError } from "../../src/runner/util.js";
import { FakeStore, fakeConfig } from "../api/fakes.js";

const profile = { full_name: "Ярослав Белов", email: "y@example.com", phone: "+7", directions: ["go"], never_claim_skills: [], exclude_words: [], company_blacklist: [] } as unknown as Profile;

function setup(applyResult: { status: Status; reasonDetail: string; questions?: never[] } = { status: Status.SENT, reasonDetail: "confirmed" }, opts: { ats?: string; checkAbort?: () => void } = {}) {
  const store = new FakeStore();
  const cfg = fakeConfig("/tmp/sgz-career-queue-test");
  const user = store.upsertUser({ slug: "y", name: "Y", tgChatId: "", dailyLimitHH: 10, dailyLimitCareer: 5, active: true, allowOtherCountry: true, poolExpandPerDay: 0, opusEnabled: false });
  store.saveProfile(user.id, profile);
  const site = store.upsertCareerSite({ userId: user.id, slug: "acme", name: "Acme", baseUrl: "https://acme.test", ats: opts.ats ?? "greenhouse", profile: { listing_url: "https://acme.test/jobs" }, enabled: true, lastRunAt: null } as never);
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
    loadCV: vi.fn(async () => ({ title: "Go", jobs: [] }) as never),
    renderTex: () => "tex",
    buildPdf: vi.fn(async (o: { outPdf: string }) => ({ pdfPath: o.outPdf, texPath: o.outPdf.replace(".pdf", ".tex") })),
    validateCV: () => [],
  };
  const llm = new FakeLLM();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ask = vi.fn(async () => {});
  const run = async (stage?: string, dryRun = false) => {
    const req = { userSlug: "y", source: "career", stage, dryRun, limit: 0, trigger: "manual" } as RunRequest;
    const ctx = {
      deps: { career, resume, notifier: { ask } }, cfg, store, llm, log, req,
      run: { id: 1 },
      now: () => new Date(),
      checkAbort: opts.checkAbort ?? (() => {}),
      throttle: { afterMutation: async () => {}, afterRead: async () => {} },
      browser: { open: vi.fn(async () => ({})), close: async () => {}, current: () => null },
      memoryGuard: async () => {},
      fileExists: (p: string) => p.endsWith("base-go.yaml"),
    } as unknown as RunContext;
    const stats = createStats(dryRun);
    await runCareerUser(ctx, { user, profile, stats }, planCareer("career", stage)!);
    return stats.snapshot();
  };
  return { store, site, apply, llm, run, user, career, resume, ask };
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

describe("career queue races and failures", () => {
  it("send: a skip / mark-sent made while the run worked is not overwritten by a failure", async () => {
    const t = setup({ status: Status.FAILED_UI, reasonDetail: "no file input" });
    await t.run();
    const id = t.store.applications[0]!.id;
    t.apply.mockImplementationOnce(async () => {
      t.store.updateApplicationStatus(id, Status.SKIP_MANUAL, "skipped in telegram");
      return { status: Status.FAILED_UI, reasonDetail: "no file input" };
    });
    await t.run(`send:${id}`);
    expect(t.store.applications[0]).toMatchObject({ status: Status.SKIP_MANUAL, reasonDetail: "skipped in telegram" });
  });

  it("inspect: does not pull a skipped / sent item back into the queue", async () => {
    const t = setup({ status: Status.SKIP_DRY_RUN, reasonDetail: "dry run" });
    await t.run();
    const id = t.store.applications[0]!.id;
    t.apply.mockImplementationOnce(async () => {
      t.store.updateApplicationStatus(id, Status.SENT, "отправлено вручную");
      return { status: Status.SKIP_DRY_RUN, reasonDetail: "" };
    });
    await t.run(`inspect:${id}`);
    expect(t.store.applications[0]).toMatchObject({ status: Status.SENT });
  });

  it("a failed send stays QUEUED with the reason, so it can be retried or marked sent, and is not re-queued", async () => {
    const t = setup({ status: Status.FAILED_NO_CONFIRMATION, reasonDetail: "no confirmation" });
    await t.run();
    const id = t.store.applications[0]!.id;
    const stats = await t.run(`send:${id}`);
    expect(stats.by_status).toEqual({ FAILED_NO_CONFIRMATION: 1 });
    expect(t.store.applications).toHaveLength(1);
    expect(t.store.applications[0]).toMatchObject({ status: Status.QUEUED, reasonDetail: "send failed: FAILED_NO_CONFIRMATION · no confirmation" });
    t.apply.mockRejectedValueOnce(new Error("page crashed"));
    await t.run(`send:${id}`);
    expect(t.store.applications[0]).toMatchObject({ status: Status.QUEUED, reasonDetail: "send failed: FAILED_UI · page crashed" });
  });

  it("retailor: a skip made while rebuilding stands, the fresh copy is dropped", async () => {
    const t = setup();
    await t.run();
    const old = t.store.applications[0]!;
    vi.mocked(t.resume.buildPdf).mockImplementationOnce(async (o: { outPdf: string }) => {
      t.store.updateApplicationStatus(old.id, Status.SKIP_MANUAL, "skipped in panel");
      return { pdfPath: o.outPdf, texPath: "x.tex" };
    });
    await t.run(`retailor:${old.id}`);
    expect(t.store.applications.map((a) => a.status)).toEqual([Status.SKIP_MANUAL, Status.SKIP_DEDUP]);
  });

  it("a failed force puts the item back on the Filtered page instead of leaving a FAILED_* row newest", async () => {
    const t = setup();
    t.llm.onDecide = (input) => input.vacancies.map((v) => ({ vacancy_id: v.id, apply: false, reason: "senior only", resume_id: "", cover_letter: "", direction: "", seniority: "", red_flags: [] }));
    await t.run();
    const rejected = t.store.applications[0]!;
    vi.mocked(t.resume.buildPdf).mockRejectedValueOnce(new Error("xelatex: boom"));
    await t.run(`force:${rejected.id}`);
    expect(t.store.applications.at(-1)).toMatchObject({ status: Status.SKIP_LLM_REJECT, reasonDetail: expect.stringContaining("force failed (FAILED_LATEX: xelatex: boom)") });
  });

  it("a run stopped while tailoring does not build, letter or queue anything afterwards", async () => {
    let stopped = false;
    const t = setup(undefined, { checkAbort: () => { if (stopped) throw new RunStoppedError(); } });
    const tailor = t.llm.onTailorCV;
    t.llm.onTailorCV = (...a) => ((stopped = true), tailor(...a));
    await expect(t.run()).rejects.toBeInstanceOf(RunStoppedError);
    expect(t.resume.buildPdf).not.toHaveBeenCalled();
    expect(t.store.applications.filter((a) => a.status === Status.QUEUED)).toHaveLength(0);
  });

  it("the daily career limit counts items queued today on every site, not only this chunk's", async () => {
    const t = setup();
    t.store.upsertUser({ ...t.user, dailyLimitCareer: 1 });
    const other = t.store.upsertVacancy({ ...(await t.career.fetch(null, t.site, {} as never)), source: "other", externalId: "o-1" } as never);
    t.store.insertApplication({ userId: t.user.id, vacancyId: other.id, hhResumeId: null, generatedResumeId: null, runId: 1, status: Status.QUEUED, reasonDetail: "", coverLetter: "", llmDecision: null, direction: "go" });
    await t.run(`site:${t.site.id}`);
    expect(t.store.applications.filter((a) => a.vacancyId !== other.id).map((a) => a.status)).not.toContain(Status.QUEUED);
  });

  it("a visit that aborts still counts as visited (and failed), so rotation moves on", async () => {
    const t = setup();
    vi.mocked(t.career.discover).mockRejectedValueOnce(new RunStoppedError());
    await expect(t.run("rotate")).rejects.toBeInstanceOf(RunStoppedError);
    expect(t.store.listCareerSites(t.user.id)[0]!.lastRunAt).not.toBeNull();
    expect(siteFails(t.store, t.site.id)).toBe(1);
    expect(careerRotation(t.store, t.user, "UTC", new Date()).sites).toEqual([]);
  });

  it("career_per_site=0 is honoured (not replaced by the default)", async () => {
    const t = setup();
    t.store.setSetting("career_per_site", "0");
    await t.run();
    expect(t.store.applications.map((a) => a.status)).not.toContain(Status.QUEUED);
    expect(t.resume.buildPdf).not.toHaveBeenCalled();
  });

  it("Habr Career (apply by hand only): the Telegram card has no «Отправить»", async () => {
    const t = setup(undefined, { ats: "site:habr-career" });
    await t.run();
    expect(t.store.applications[0]!.status).toBe(Status.QUEUED);
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect((t.ask.mock.calls[0] as unknown as [string, { data: string }[]])[1].map((b) => b.data)).toEqual([`q:k:${t.store.applications[0]!.id}`]);
  });
});

describe("career rotation order", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * 864e5).toISOString();

  it("rotationScore: cold first, a week-old site forced, 5 failures parked until a week passes", () => {
    expect(rotationScore({ lastRunAt: null }, undefined, 0, now)).toBe(Infinity);
    expect(rotationScore({ lastRunAt: ago(8) }, undefined, 9, now)).toBeGreaterThan(1000);
    expect(rotationScore({ lastRunAt: ago(2) }, undefined, 5, now)).toBe(-Infinity);
    const productive = rotationScore({ lastRunAt: ago(2) }, { found: 20, queued: 3 }, 0, now);
    const empty = rotationScore({ lastRunAt: ago(3) }, { found: 0, queued: 0 }, 0, now);
    const failing = rotationScore({ lastRunAt: ago(3) }, { found: 0, queued: 0 }, 2, now);
    expect(productive).toBeGreaterThan(empty);
    expect(empty).toBeGreaterThan(failing);
  });

  it("careerRotation sorts by score and drops parked sites", () => {
    const t = setup();
    const add = (slug: string, lastRunAt: string | null) =>
      t.store.upsertCareerSite({ userId: t.user.id, slug, name: slug, baseUrl: `https://${slug}.test`, ats: "greenhouse", profile: {}, enabled: true, lastRunAt });
    t.store.upsertCareerSite({ ...t.site, lastRunAt: ago(3) }); // acme: nothing found
    add("good", ago(2));
    add("cold", null);
    add("stale", ago(9));
    const blocked = add("blocked", ago(2));
    t.store.setSetting(`site_fail:${blocked.id}`, "5");
    t.store.careerSiteYield = () => ({ good: { found: 10, queued: 2 } });
    expect(careerRotation(t.store, t.user, "UTC", now).sites.map((s) => s.slug)).toEqual(["cold", "stale", "good", "acme"]);
  });

  it("a failed discovery bumps the site's fail counter, a clean visit resets it", async () => {
    const t = setup();
    vi.mocked(t.career.discover).mockRejectedValueOnce(new Error("captcha")).mockRejectedValueOnce(new Error("captcha"));
    await t.run();
    await t.run();
    expect(siteFails(t.store, t.site.id)).toBe(2);
    await t.run();
    expect(siteFails(t.store, t.site.id)).toBe(0);
  });
});
