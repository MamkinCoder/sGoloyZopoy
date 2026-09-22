import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harness } from "./fakes.js";

describe("resumes", () => {
  it("lists hh pool + generated with urls, capacity from settings", async () => {
    const h = await harness();
    const u = h.store.getUserBySlug("yaroslav")!;
    h.store.upsertHHResume({ userId: u.id, hhResumeId: "abc", title: "Go dev", url: "https://hh.ru/resume/abc", direction: "go", summary: null, isGenerated: false, syncedAt: "2026-01-01T00:00:00Z" });
    const v = h.store.upsertVacancy({ source: "acme", externalId: "https://acme.io/jobs/1", url: "https://acme.io/jobs/1", title: "Backend", company: "Acme", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "" });
    const g = h.store.insertGeneratedResume({ userId: u.id, vacancyId: v.id, texPath: join(h.cfg.dataDir, "g.tex"), pdfPath: join(h.cfg.dataDir, "g.pdf"), model: "sonnet" });
    h.store.setSetting("resume_capacity:yaroslav", JSON.stringify({ created: 3, max: 20 }));

    const body = await (await h.get("/api/users/yaroslav/resumes")).json();
    expect(body.hh).toHaveLength(1);
    expect(body.last_synced).toBe("2026-01-01T00:00:00Z");
    expect(body.capacity).toEqual({ created: 3, max: 20 });
    expect(body.generated[0]).toMatchObject({ id: g.id, vacancy_title: "Backend", company: "Acme", pdf_url: `/api/resumes/${g.id}/pdf`, tex_url: `/api/resumes/${g.id}/tex`, model: "sonnet" });
  });

  it("sync/expand/touch start pool runs; 409 when busy", async () => {
    const h = await harness();
    const sync = await h.json("POST", "/api/users/yaroslav/resumes/sync");
    expect(sync.status).toBe(202);
    expect(await sync.json()).toEqual({ run_id: expect.any(Number) });
    await h.json("POST", "/api/users/yaroslav/resumes/expand", { max: 3 });
    await h.json("POST", "/api/users/yaroslav/resumes/expand");
    await h.json("POST", "/api/users/yaroslav/resumes/touch");
    expect(h.runner.started.map((r) => [r.source, r.stage, r.limit])).toEqual([
      ["pool", "pool-sync", 0],
      ["pool", "pool-expand", 3],
      ["pool", "pool-expand", 0],
      ["pool", "touch", 0],
    ]);
    h.runner.busy = true;
    const busy = await h.json("POST", "/api/users/yaroslav/resumes/sync");
    expect(busy.status).toBe(409);
  });

  it("serves pdf/tex under dataDir and rejects traversal outside it", async () => {
    const h = await harness();
    const u = h.store.getUserBySlug("yaroslav")!;
    const gen = join(h.cfg.dataDir, "users/yaroslav/generated");
    mkdirSync(gen, { recursive: true });
    writeFileSync(join(gen, "r.pdf"), "%PDF-1.4 fake");
    writeFileSync(join(gen, "r.tex"), "\\documentclass{article}");
    const ok = h.store.insertGeneratedResume({ userId: u.id, vacancyId: 1, texPath: join(gen, "r.tex"), pdfPath: join(gen, "r.pdf"), model: "" });
    const evil = h.store.insertGeneratedResume({ userId: u.id, vacancyId: 1, texPath: join(gen, "../../../../../../etc/passwd"), pdfPath: "/etc/passwd", model: "" });
    const trick = h.store.insertGeneratedResume({ userId: u.id, vacancyId: 1, texPath: `${h.cfg.dataDir}-other/x.tex`, pdfPath: `${h.cfg.dataDir}-other/x.pdf`, model: "" });

    const pdf = await h.get(`/api/resumes/${ok.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(await pdf.text()).toBe("%PDF-1.4 fake");
    const tex = await h.get(`/api/resumes/${ok.id}/tex`);
    expect(tex.headers.get("content-type")).toContain("text/plain");
    expect(await tex.text()).toContain("documentclass");

    expect((await h.get(`/api/resumes/${evil.id}/pdf`)).status).toBe(404);
    expect((await h.get(`/api/resumes/${evil.id}/tex`)).status).toBe(404);
    expect((await h.get(`/api/resumes/${trick.id}/pdf`)).status).toBe(404);
    expect((await h.get(`/api/resumes/12345/pdf`)).status).toBe(404);
  });
});
