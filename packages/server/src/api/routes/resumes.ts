import { Hono } from "hono";
import type { GeneratedResumeDTO, ResumesDTO, RunRequest } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { notFound } from "../errors.js";
import { guardedFile } from "../files.js";
import { ExpandSchema, parseOptionalBody } from "../validate.js";
import { idParam, userOr404 } from "./common.js";

function capacityFor(deps: ApiDeps, slug: string): ResumesDTO["capacity"] {
  const raw = deps.store.getSetting(`resume_capacity:${slug}`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { created?: unknown; max?: unknown };
    if (typeof v.created === "number" && typeof v.max === "number") return { created: v.created, max: v.max };
  } catch {
    /* malformed setting → treat as absent */
  }
  return null;
}

export function resumeRoutes(deps: ApiDeps): Hono {
  const { store, runner } = deps;
  const r = new Hono();

  r.get("/users/:slug/resumes", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const hh = store.listHHResumes(u.id);
    const generated: GeneratedResumeDTO[] = store.listGeneratedResumes(u.id).map((g) => {
      const v = store.getVacancy(g.vacancyId);
      return {
        id: g.id,
        vacancy_id: g.vacancyId,
        vacancy_title: v?.title ?? "",
        company: v?.company ?? "",
        pdf_url: `/api/resumes/${g.id}/pdf`,
        tex_url: `/api/resumes/${g.id}/tex`,
        model: g.model,
        created_at: g.createdAt,
      };
    });
    const lastSynced = hh.map((h) => h.syncedAt).sort().at(-1) ?? null;
    const body: ResumesDTO = { hh, generated, last_synced: lastSynced, capacity: capacityFor(deps, u.slug) };
    return c.json(body);
  });

  const poolRun = async (slug: string, stage: string, limit = 0) => {
    const req: RunRequest = { userSlug: slug, source: "pool", stage, dryRun: false, limit, trigger: "manual" };
    return runner.start(req);
  };

  r.post("/users/:slug/resumes/sync", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    return c.json({ run_id: await poolRun(u.slug, "pool-sync") }, 202);
  });

  r.post("/users/:slug/resumes/expand", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const body = await parseOptionalBody(c, ExpandSchema);
    return c.json({ run_id: await poolRun(u.slug, "pool-expand", body.max ?? 0) }, 202);
  });

  r.post("/users/:slug/resumes/touch", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    return c.json({ run_id: await poolRun(u.slug, "touch") }, 202);
  });

  const generatedOr404 = (id: number) => {
    const g = store.getGeneratedResume(id);
    if (!g) throw notFound("resume not found");
    return g;
  };

  r.get("/resumes/:id/pdf", (c) => {
    const g = generatedOr404(idParam(c));
    return guardedFile(deps.cfg.dataDir, g.pdfPath, "application/pdf", {
      "Content-Disposition": `inline; filename="resume-${g.id}.pdf"`,
    });
  });

  r.get("/resumes/:id/tex", (c) => {
    const g = generatedOr404(idParam(c));
    return guardedFile(deps.cfg.dataDir, g.texPath, "text/plain; charset=utf-8");
  });

  return r;
}
