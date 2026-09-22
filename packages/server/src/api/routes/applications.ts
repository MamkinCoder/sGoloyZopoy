import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { paths, type ApplicationDetailDTO, type ApplicationRow, type Paged, type ApplicationDTO } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { notFound } from "../errors.js";
import { guardedFile } from "../files.js";
import { pagination, statusList } from "../validate.js";
import { idParam, toApplicationDTO, userOr404 } from "./common.js";

/** `${snapshots(run)}/${externalId}*.html` if such a file exists. externalId may be a URL for
 *  career sites, so match by prefix on the directory listing rather than by glob. */
function findSnapshot(deps: ApiDeps, row: ApplicationRow): string | null {
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
  const { store } = deps;
  const r = new Hono();

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
    const row = store.getApplication(id);
    if (!row) throw notFound("application not found");
    const dto: ApplicationDetailDTO = {
      ...toApplicationDTO(row),
      questionnaire: store.listQuestionnaireAnswers(id).map((qa) => ({ question: qa.question, answer: qa.answer })),
      decision: row.application.llmDecision,
      snapshot_url: findSnapshot(deps, row) ? `/api/applications/${id}/snapshot` : null,
    };
    return c.json(dto);
  });

  r.get("/applications/:id/snapshot", (c) => {
    const row = store.getApplication(idParam(c));
    if (!row) throw notFound("application not found");
    const file = findSnapshot(deps, row);
    if (!file) throw notFound("no snapshot");
    return guardedFile(deps.cfg.dataDir, file, "text/html; charset=utf-8");
  });

  return r;
}
