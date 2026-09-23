import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paths } from "@sgz/shared";
import { harness, type Harness } from "./fakes.js";

function seed(h: Harness) {
  const u = h.store.getUserBySlug("yaroslav")!;
  const mk = (i: number, source: string, status: "SENT" | "SKIP_DEDUP" | "FAILED_UI") => {
    const v = h.store.upsertVacancy({
      source,
      externalId: `v${i}`,
      url: `https://hh.ru/vacancy/${i}`,
      title: i % 2 ? "Go developer" : "Node developer",
      company: `Co${i}`,
      salaryFrom: 0,
      salaryTo: 0,
      currency: "",
      descriptionText: "",
      hasTest: false,
      requiresLetter: false,
      area: "",
      workFormat: "",
      publishedAt: null,
      archived: false,
      dedupHash: "",
    });
    return h.store.insertApplication({
      userId: u.id,
      vacancyId: v.id,
      hhResumeId: null,
      generatedResumeId: null,
      runId: 7,
      status,
      reasonDetail: status === "SKIP_DEDUP" ? "same company" : "",
      coverLetter: "",
      llmDecision: null,
    });
  };
  const apps = [];
  for (let i = 1; i <= 6; i++) apps.push(mk(i, i <= 4 ? "hh" : "acme", i === 2 ? "SKIP_DEDUP" : i === 3 ? "FAILED_UI" : "SENT"));
  return apps;
}

describe("applications", () => {
  it("filters by status csv, source, q and paginates", async () => {
    const h = await harness();
    seed(h);
    const all = await (await h.get("/api/users/yaroslav/applications")).json();
    expect(all.total).toBe(6);
    expect(all.page).toBe(1);
    expect(all.page_size).toBe(50);
    expect(all.items[0]).toHaveProperty("application");
    expect(all.items[0]).toHaveProperty("vacancy");
    expect(all.items[0]).toHaveProperty("resume_title");

    const st = await (await h.get("/api/users/yaroslav/applications?status=SKIP_DEDUP,FAILED_UI")).json();
    expect(st.total).toBe(2);
    const src = await (await h.get("/api/users/yaroslav/applications?source=acme")).json();
    expect(src.total).toBe(2);
    const q = await (await h.get("/api/users/yaroslav/applications?q=go%20dev")).json();
    expect(q.total).toBe(3);

    const p2 = await (await h.get("/api/users/yaroslav/applications?page=2&page_size=4")).json();
    expect(p2.items).toHaveLength(2);
    expect(p2.page).toBe(2);
    expect(p2.total).toBe(6);

    expect((await h.get("/api/users/yaroslav/applications?page_size=201")).status).toBe(400);
    expect((await h.get("/api/users/yaroslav/applications?status=BOGUS")).status).toBe(400);
  });

  it("detail includes questionnaire, decision and snapshot url; snapshot served under dataDir", async () => {
    const h = await harness();
    const [a1] = seed(h);
    h.store.insertQuestionnaireAnswers(a1!.id, [{ idx: 0, text: "Relocate?", kind: "radio", options: ["yes", "no"], required: true }], [{ idx: 0, option_idx: 1 }]);

    const noSnap = await (await h.get(`/api/applications/${a1!.id}`)).json();
    expect(noSnap.snapshot_url).toBeNull();
    expect(noSnap.questionnaire).toHaveLength(1);
    expect(noSnap.questionnaire[0].answer).toEqual({ idx: 0, option_idx: 1 });
    expect(noSnap.decision).toBeNull();

    const dir = paths.snapshots(h.cfg, 7);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/v1-apply.html`, "<h1>snap</h1>");
    const withSnap = await (await h.get(`/api/applications/${a1!.id}`)).json();
    expect(withSnap.snapshot_url).toBe(`/api/applications/${a1!.id}/snapshot`);
    const snap = await h.get(withSnap.snapshot_url);
    expect(snap.status).toBe(200);
    expect(snap.headers.get("content-type")).toContain("text/html");
    expect(await snap.text()).toBe("<h1>snap</h1>");

    // a career send snapshots as career-<slug>-<id> in the send run's own dir, not the discovery run's
    const site = h.store.upsertVacancy({ ...h.store.getApplication(a1!.id)!.vacancy, id: undefined, source: "acme", externalId: "https://acme.test/job/9" } as never);
    const siteApp = h.store.insertApplication({ ...h.store.getApplication(a1!.id)!.application, vacancyId: site.id, runId: 3 });
    expect((await (await h.get(`/api/applications/${siteApp.id}`)).json()).snapshot_url).toBeNull();
    const sendDir = paths.snapshots(h.cfg, 12);
    mkdirSync(sendDir, { recursive: true });
    writeFileSync(`${sendDir}/career-acme-https_acme_test_job_9.html`, "<h1>form</h1>");
    expect(await (await h.get(`/api/applications/${siteApp.id}/snapshot`)).text()).toBe("<h1>form</h1>");

    expect((await h.get("/api/applications/999")).status).toBe(404);
    expect((await h.get("/api/applications/abc")).status).toBe(400);
  });

  it("dedup rows for a run", async () => {
    const h = await harness();
    seed(h);
    h.store.insertRun({ userId: 1, source: "hh", trigger: "manual", status: "done", stats: { found: 0, deduped: 0, by_status: {}, chat_replies: 0, invitations: 0, rejections: 0, top_vacancies: [], dry_run: false, llm_calls: 0 }, tgSent: false, error: "" });
    const run = h.store.runs[0]!;
    for (const a of h.store.applications) a.runId = run.id;
    const rows = await (await h.get(`/api/runs/${run.id}/dedup`)).json();
    expect(rows).toEqual([{ vacancy: { title: "Node developer", company: "Co2", url: "https://hh.ru/vacancy/2" }, reason: "SKIP_DEDUP", detail: "same company" }]);
  });
});
