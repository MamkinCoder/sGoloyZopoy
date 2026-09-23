import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { FILTERED_STATUSES, paths, Status, type ApplicationDetailDTO, type ApplicationRow, type FilteredItemDTO, type Paged, type ApplicationDTO, type QueueItemDTO, type RunRequest } from "@sgz/shared";
import { cvFileName } from "../../career/agent-apply.js";
import { manualApplyOnly } from "../../career/agent.js";
import { sendingNow } from "../../runner/queue-cards.js";
import type { ApiDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { guardedFile } from "../files.js";
import { CoverLetterSchema, intParam, pagination, parseBody, statusList } from "../validate.js";
import { idParam, toApplicationDTO, userOr404 } from "./common.js";

/** `${snapshots(run)}/${externalId}*.html` if such a file exists. externalId may be a URL for
 *  career sites, so match by prefix on the directory listing rather than by glob. */
function findSnapshot(deps: ApiDeps, row: ApplicationRow): string | null {
  // A career send/inspect runs later than discovery, in its own run dir, as applyViaAgent's `career-<slug>-<id>`.
  if (row.vacancy.source !== "hh") {
    const root = paths.snapshots(deps.cfg);
    const name = `career-${row.vacancy.source}-${row.vacancy.externalId.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}`.replace(/[^a-z0-9._-]/gi, "_");
    const hit = existsSync(root)
      ? readdirSync(root)
          .filter((d) => /^run-\d+$/.test(d))
          .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))
          .map((d) => join(root, d, `${name}.html`))
          .find((f) => existsSync(f))
      : undefined;
    if (hit) return hit;
  }
  const dir = paths.snapshots(deps.cfg, row.application.runId);
  if (!existsSync(dir)) return null;
  const prefix = row.vacancy.externalId.replace(/[^\w.-]+/g, "_");
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".html") && (f.startsWith(row.vacancy.externalId) || f.startsWith(prefix)))
    .sort()
    .at(-1);
  return hit ? join(dir, hit) : null;
}

export function applicationRoutes(deps: ApiDeps): Hono {
  const { store, runner } = deps;
  const r = new Hono();
  const rowOr404 = (id: number) => {
    const row = store.getApplication(id);
    if (!row) throw notFound("application not found");
    return row;
  };

  r.get("/users/:slug/applications", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const { page, pageSize } = pagination(c);
    const q = c.req.query();
    const res = store.listApplications({
      userId: u.id,
      status: statusList(q.status),
      source: q.source || undefined,
      since: q.since || undefined,
      until: q.until || undefined,
      q: q.q || undefined,
      page,
      pageSize,
    });
    const body: Paged<ApplicationDTO> = { items: res.items.map(toApplicationDTO), total: res.total, page, page_size: pageSize };
    return c.json(body);
  });

  r.get("/applications/:id", (c) => {
    const id = idParam(c);
    const row = rowOr404(id);
    const dto: ApplicationDetailDTO = {
      ...toApplicationDTO(row),
      questionnaire: store.listQuestionnaireAnswers(id).map((qa) => ({ question: qa.question, answer: qa.answer })),
      decision: row.application.llmDecision,
      snapshot_url: findSnapshot(deps, row) ? `/api/applications/${id}/snapshot` : null,
    };
    return c.json(dto);
  });

  r.get("/applications/:id/snapshot", (c) => {
    const row = rowOr404(idParam(c));
    const file = findSnapshot(deps, row);
    if (!file) throw notFound("no snapshot");
    return guardedFile(deps.cfg.dataDir, file, "text/html; charset=utf-8");
  });

  const siteOf = (userId: number, slug: string) => {
    const site = deps.store.listCareerSites(userId).find((x) => x.slug === slug);
    return site ? { name: site.name, slug: site.slug } : null;
  };

  // Review queue: career applications with a ready CV + letter, waiting for «Отправить» / «Пропустить».
  r.get("/users/:slug/queue", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const profile = store.getProfile(u.id);
    const rows = store.listApplications({ userId: u.id, status: [Status.QUEUED], page: 1, pageSize: 200 }).items;
    const sitesBySlug = new Map(store.listCareerSites(u.id).map((s) => [s.slug, s]));
    const items: QueueItemDTO[] = rows.map(({ application: a, vacancy: v }) => ({
      id: a.id,
      created_at: a.createdAt,
      vacancy: { id: v.id, title: v.title, company: v.company, url: v.url, area: v.area, work_format: v.workFormat, salary_from: v.salaryFrom, salary_to: v.salaryTo, currency: v.currency },
      site: siteOf(u.id, v.source),
      pdf_url: a.generatedResumeId ? `/api/resumes/${a.generatedResumeId}/pdf` : null,
      manual_apply: manualApplyOnly(sitesBySlug.get(v.source)?.ats ?? "custom"),
      cover_letter: a.coverLetter,
      reason: a.llmDecision?.reason ?? "",
      detail: a.reasonDetail,
      form: {
        full_name: profile?.full_name ?? "",
        email: profile?.email ?? "",
        phone: profile?.phone ?? "",
        cv_file_name: cvFileName(profile?.full_name ?? ""),
        cover_letter: a.coverLetter,
      },
      questionnaire: store.listQuestionnaireAnswers(a.id).map((qa) => ({ question: qa.question, answer: qa.answer })),
    }));
    return c.json(items);
  });

  // Vacancies whose newest application row is a filter / LLM-gate skip, newest first.
  r.get("/users/:slug/filtered", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const q = c.req.query();
    const source = q.source && q.source !== "all" ? q.source : undefined;
    const days = q.days ? intParam(q.days, "days") : 7;
    const limit = q.limit ? intParam(q.limit, "limit") : 100;
    const rows = store.listApplications({
      userId: u.id,
      status: [...FILTERED_STATUSES],
      source,
      since: new Date(Date.now() - days * 86_400_000).toISOString(),
      latestPerVacancy: true,
      page: 1,
      pageSize: limit,
    }).items;
    const items: FilteredItemDTO[] = rows.map(({ application: a, vacancy: v }) => ({
      id: a.id,
      created_at: a.createdAt,
      status: a.status,
      reason: a.reasonDetail || a.llmDecision?.reason || "",
      vacancy: { id: v.id, title: v.title, company: v.company, url: v.url, source: v.source },
      site: v.source === "hh" ? null : siteOf(u.id, v.source),
    }));
    return c.json(items);
  });

  const queuedOr400 = (id: number) => {
    const row = rowOr404(id);
    if (row.application.status !== Status.QUEUED) throw badRequest(`application is ${row.application.status}, not queued`);
    return row;
  };
  const startFor = async (row: ApplicationRow, source: RunRequest["source"], stage: string) => {
    const slug = store.listUsers().find((u) => u.id === row.application.userId)?.slug;
    if (!slug) throw notFound("user not found");
    return runner.start({ userSlug: slug, source, stage, dryRun: false, limit: 0, trigger: "manual" }); // RunBusyError → 409
  };

  r.put("/applications/:id/cover-letter", async (c) => {
    const id = idParam(c);
    queuedOr400(id);
    const { text } = await parseBody(c, CoverLetterSchema);
    store.updateApplicationCoverLetter(id, text);
    return c.json({ ok: true });
  });

  for (const mode of ["send", "inspect", "retailor"] as const) {
    r.post(`/applications/:id/${mode}`, async (c) => {
      const id = idParam(c);
      const row = queuedOr400(id);
      if (mode === "send" && manualApplyOnly(store.listCareerSites(row.application.userId).find((s) => s.slug === row.vacancy.source)?.ats ?? "custom"))
        throw badRequest("этот сайт принимает отклик только вручную: откликнитесь на сайте и нажмите «Отправил вручную»");
      return c.json({ run_id: await startFor(row, "career", `${mode}:${id}`) }, 202);
    });
  }

  r.post("/applications/:id/skip", (c) => {
    const id = idParam(c);
    queuedOr400(id);
    if (sendingNow(runner, id)) return c.json({ error: "сейчас отправляется" }, 409);
    store.updateApplicationStatus(id, Status.SKIP_MANUAL, "skipped in panel");
    return c.json({ ok: true });
  });

  // The human applied on the site by hand (Habr Career needs their login, some sites block bots).
  r.post("/applications/:id/mark-sent", (c) => {
    const id = idParam(c);
    queuedOr400(id);
    if (sendingNow(runner, id)) return c.json({ error: "сейчас отправляется" }, 409);
    store.updateApplicationStatus(id, Status.SENT, "отправлено вручную");
    return c.json({ ok: true });
  });

  // «Всё равно откликнуться»: hh applies right away, career sites go through tailoring into the queue.
  r.post("/applications/:id/force", async (c) => {
    const id = idParam(c);
    const row = rowOr404(id);
    if (!FILTERED_STATUSES.includes(row.application.status)) throw badRequest(`application is ${row.application.status}, not filtered`);
    return c.json({ run_id: await startFor(row, row.vacancy.source === "hh" ? "hh" : "career", `force:${id}`) }, 202);
  });

  return r;
}
