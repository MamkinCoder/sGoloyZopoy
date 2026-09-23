import { Hono } from "hono";
import type { CareerSite, CareerSiteDTO, RunRequest } from "@sgz/shared";
import { siteFails, YIELD_DAYS } from "../../runner/career.js";
import { isoDaysAgo } from "../../runner/filters.js";
import type { ApiDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import { ATS_KINDS, CareerSiteSchema, parseBody } from "../validate.js";
import { idParam, userOr404 } from "./common.js";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "site";

export function careerRoutes(deps: ApiDeps): Hono {
  const { store, runner } = deps;
  const r = new Hono();

  const siteOr404 = (id: number): CareerSite => {
    const s = store.getCareerSite(id);
    if (!s) throw notFound("career site not found");
    return s;
  };

  r.get("/users/:slug/career-sites", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const y = store.careerSiteYield(u.id, isoDaysAgo(new Date(), YIELD_DAYS));
    const sites: CareerSiteDTO[] = store
      .listCareerSites(u.id)
      .map((s) => ({ ...s, yield: y[s.slug] ?? { found: 0, queued: 0 }, fails: siteFails(store, s.id) }));
    return c.json(sites);
  });

  r.post("/users/:slug/career-sites", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const b = await parseBody(c, CareerSiteSchema);
    const baseUrl = b.base_url ?? b.baseUrl;
    if (!baseUrl) throw badRequest("base_url is required");
    const slug = b.slug ?? slugify(new URL(baseUrl).hostname);
    const site = store.upsertCareerSite({
      userId: u.id,
      slug,
      name: b.name ?? slug,
      baseUrl,
      ats: b.adapter ?? b.ats ?? "custom",
      profile: b.config ?? b.profile ?? {},
      enabled: b.enabled ?? true,
      lastRunAt: null,
    });
    return c.json(site, 201);
  });

  r.put("/career-sites/:id", async (c) => {
    const cur = siteOr404(idParam(c));
    const b = await parseBody(c, CareerSiteSchema);
    const site = store.upsertCareerSite({
      ...cur,
      name: b.name ?? cur.name,
      slug: b.slug ?? cur.slug,
      baseUrl: b.base_url ?? b.baseUrl ?? cur.baseUrl,
      ats: b.adapter ?? b.ats ?? cur.ats,
      profile: b.config ?? b.profile ?? cur.profile,
      enabled: b.enabled ?? cur.enabled,
    });
    return c.json(site);
  });

  r.delete("/career-sites/:id", (c) => {
    siteOr404(idParam(c));
    store.deleteCareerSite(idParam(c));
    return c.json({ ok: true });
  });

  r.post("/users/:slug/career-sites/:id/onboard", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const site = siteOr404(idParam(c));
    if (site.userId !== u.id) throw notFound("career site not found");
    const req: RunRequest = { userSlug: u.slug, source: "career", stage: `onboard:${site.id}`, dryRun: false, limit: 0, trigger: "manual" };
    return c.json({ run_id: await runner.start(req) }, 202);
  });

  r.get("/adapters", (c) => c.json(deps.adapters ?? [...ATS_KINDS]));

  return r;
}
