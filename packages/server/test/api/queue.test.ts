import { describe, expect, it } from "vitest";
import type { Status } from "@sgz/shared";
import { harness, type Harness } from "./fakes.js";

function seed(h: Harness) {
  const u = h.store.getUserBySlug("yaroslav")!;
  h.store.saveProfile(u.id, { full_name: "Ярослав Белов", email: "y@example.com", phone: "+70000000000" } as never);
  h.store.upsertCareerSite({ userId: u.id, slug: "acme", name: "Acme", baseUrl: "https://acme.test", ats: "custom", profile: {}, enabled: true, lastRunAt: null } as never);
  const gen = h.store.insertGeneratedResume({ userId: u.id, vacancyId: 0, texPath: "/x.tex", pdfPath: "/x.pdf", model: "write" });
  const mk = (source: string, status: Status, extra: { reasonDetail?: string } = {}) => {
    const v = h.store.upsertVacancy({
      source, externalId: `${source}-${h.store.vacancies.length}`, url: "https://acme.test/job/1", title: "Go developer", company: "Acme",
      salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "", hasTest: false, requiresLetter: false, area: "Москва", workFormat: "remote",
      publishedAt: null, archived: false, dedupHash: "",
    });
    return h.store.insertApplication({
      userId: u.id, vacancyId: v.id, hhResumeId: null, generatedResumeId: status === "QUEUED" ? gen.id : null, runId: 1, status,
      reasonDetail: extra.reasonDetail ?? "", coverLetter: status === "QUEUED" ? "Здравствуйте. Готов обсудить детали." : "",
      llmDecision: status === "QUEUED" || status === "SKIP_LLM_REJECT" ? ({ reason: "стек совпадает" } as never) : null, direction: "go",
    });
  };
  return { u, gen, mk };
}

describe("review queue", () => {
  it("lists queued career applications with pdf, letter and form preview", async () => {
    const h = await harness();
    const { gen, mk } = seed(h);
    const q = mk("acme", "QUEUED");
    mk("acme", "SENT");
    h.store.insertQuestionnaireAnswers(q.id, [{ idx: 0, text: "Опыт с Go?", kind: "text", required: true }], [{ idx: 0, text: "2 года" }]);
    const items = await (await h.get("/api/users/yaroslav/queue")).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: q.id,
      vacancy: { title: "Go developer", company: "Acme", url: "https://acme.test/job/1", area: "Москва", work_format: "remote" },
      site: { name: "Acme", slug: "acme" },
      pdf_url: `/api/resumes/${gen.id}/pdf`,
      reason: "стек совпадает",
      form: { full_name: "Ярослав Белов", email: "y@example.com", phone: "+70000000000", cv_file_name: "Белов_Ярослав_CV.pdf" },
      questionnaire: [{ question: { text: "Опыт с Go?" }, answer: { text: "2 года" } }],
    });
  });

  it("edits the cover letter and skips only while queued", async () => {
    const h = await harness();
    const { mk } = seed(h);
    const q = mk("acme", "QUEUED");
    expect((await h.json("PUT", `/api/applications/${q.id}/cover-letter`, { text: "Новый текст." })).status).toBe(200);
    expect(h.store.getApplication(q.id)!.application.coverLetter).toBe("Новый текст.");
    expect((await h.json("PUT", `/api/applications/${q.id}/cover-letter`, { text: "" })).status).toBe(400);
    expect((await h.json("POST", `/api/applications/${q.id}/skip`)).status).toBe(200);
    expect(h.store.getApplication(q.id)!.application.status).toBe("SKIP_MANUAL");
    expect((await h.json("POST", `/api/applications/${q.id}/skip`)).status).toBe(400);
    expect((await h.json("PUT", `/api/applications/${q.id}/cover-letter`, { text: "x" })).status).toBe(400);
  });

  it("mark-sent records a manual application, only while queued", async () => {
    const h = await harness();
    const q = seed(h).mk("acme", "QUEUED");
    expect((await h.json("POST", `/api/applications/${q.id}/mark-sent`)).status).toBe(200);
    expect(h.store.getApplication(q.id)!.application).toMatchObject({ status: "SENT", reasonDetail: "отправлено вручную" });
    expect((await h.json("POST", `/api/applications/${q.id}/mark-sent`)).status).toBe(400);
  });

  it("send / inspect start a career run for that application; 409 when busy", async () => {
    const h = await harness();
    const { mk } = seed(h);
    const q = mk("acme", "QUEUED");
    const res = await h.json("POST", `/api/applications/${q.id}/send`);
    expect(res.status).toBe(202);
    expect((await res.json()).run_id).toEqual(expect.any(Number));
    expect(h.runner.started.at(-1)).toMatchObject({ userSlug: "yaroslav", source: "career", stage: `send:${q.id}`, dryRun: false });
    expect((await h.json("POST", `/api/applications/${q.id}/inspect`)).status).toBe(202);
    expect(h.runner.started.at(-1)).toMatchObject({ stage: `inspect:${q.id}` });
    h.runner.busy = true;
    expect((await h.json("POST", `/api/applications/${q.id}/send`)).status).toBe(409);
    const sent = mk("acme", "SENT");
    h.runner.busy = false;
    expect((await h.json("POST", `/api/applications/${sent.id}/send`)).status).toBe(400);
    expect((await h.json("POST", "/api/applications/99999/send")).status).toBe(404);
  });
});

describe("manual-only boards", () => {
  it("send is refused for Habr Career (the human applies with their own login); inspect / mark-sent still work", async () => {
    const h = await harness();
    const { u, mk } = seed(h);
    h.store.upsertCareerSite({ userId: u.id, slug: "habr", name: "Habr Career", baseUrl: "https://career.habr.com", ats: "site:habr-career", profile: {}, enabled: true, lastRunAt: null } as never);
    const q = mk("habr", "QUEUED");
    expect((await h.json("POST", `/api/applications/${q.id}/send`)).status).toBe(400);
    expect(h.runner.started).toHaveLength(0);
    expect((await h.json("POST", `/api/applications/${q.id}/mark-sent`)).status).toBe(200);
  });
});

describe("filtered list + force", () => {
  it("lists the newest filter skip per vacancy, excluding dry-run, already-applied and queued", async () => {
    const h = await harness();
    const { mk } = seed(h);
    const f1 = mk("hh", "SKIP_FILTER", { reasonDetail: "exclude word: senior" });
    const rej = mk("acme", "SKIP_LLM_REJECT");
    mk("hh", "SKIP_DRY_RUN");
    mk("hh", "SKIP_ALREADY_APPLIED");
    mk("acme", "QUEUED");
    // a filtered vacancy that was later sent drops out
    const later = mk("hh", "SKIP_DEDUP");
    h.store.insertApplication({ ...h.store.getApplication(later.id)!.application, status: "SENT" });

    const all = await (await h.get("/api/users/yaroslav/filtered")).json();
    expect(all.map((x: { id: number }) => x.id).sort()).toEqual([f1.id, rej.id].sort());
    const hh = await (await h.get("/api/users/yaroslav/filtered?source=hh")).json();
    expect(hh).toEqual([expect.objectContaining({ id: f1.id, status: "SKIP_FILTER", reason: "exclude word: senior", site: null })]);
    const career = await (await h.get("/api/users/yaroslav/filtered?source=career")).json();
    expect(career).toEqual([expect.objectContaining({ id: rej.id, reason: "стек совпадает", site: { name: "Acme", slug: "acme" } })]);
  });

  it("force starts an hh or career run by the vacancy source; 409 when busy; 400 when not filtered", async () => {
    const h = await harness();
    const { mk } = seed(h);
    const hhRow = mk("hh", "SKIP_FILTER");
    const siteRow = mk("acme", "SKIP_COMPANY_LIMIT");
    const res = await h.json("POST", `/api/applications/${hhRow.id}/force`);
    expect(res.status).toBe(202);
    expect((await res.json()).run_id).toEqual(expect.any(Number));
    expect(h.runner.started.at(-1)).toMatchObject({ source: "hh", stage: `force:${hhRow.id}` });
    expect((await h.json("POST", `/api/applications/${siteRow.id}/force`)).status).toBe(202);
    expect(h.runner.started.at(-1)).toMatchObject({ source: "career", stage: `force:${siteRow.id}` });
    h.runner.busy = true;
    expect((await h.json("POST", `/api/applications/${hhRow.id}/force`)).status).toBe(409);
    h.runner.busy = false;
    const sent = mk("hh", "SENT");
    expect((await h.json("POST", `/api/applications/${sent.id}/force`)).status).toBe(400);
  });
});
