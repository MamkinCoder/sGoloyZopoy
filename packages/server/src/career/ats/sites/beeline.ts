// Beeline careers site (job.beeline.ru), a React SPA. No docs; API base found in the JS bundle's
// env config (VITE_LK_API_SERVER_URL: same origin) and endpoint paths in its RTK Query `go` object.
// Verified live 2026-09 (~1560 open vacancies across all of Beeline, not just IT).
//   GET /api/v1/vacancies/?limit=&offset=  -> list, DRF-style {count,next,previous,results}
//   GET /api/v1/vacancies/{id}             -> detail (redirects to trailing-slash form; same shape
//                                              as a list item plus HTML `description`)
// Each vacancy also carries external_system_name (SKILLAZ, POTOK, ...): Beeline aggregates several
// upstream ATS/recruiting tools behind this one public API, so this client reads Beeline's own
// unified endpoint rather than the upstream systems directly.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.beeline.ru";
const LIST_API = `${ORIGIN}/api/v1/vacancies/`;
const COMPANY = "Beeline";
const PAGE_SIZE = 200;

interface BeelineVacancy {
  id: string;
  name: string;
  grade?: string;
  gross_salary_from?: string;
  gross_salary_to?: string;
  location_address?: string | null;
  format?: string[];
  description?: string;
  city?: { name: string; display_region?: string }[];
}

interface BeelineListPage {
  count: number;
  next: string | null;
  results: BeelineVacancy[];
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "job.beeline.ru") return { token: ORIGIN };
  return /job\.beeline\.ru\/api\/v1\/vacancies/.test(html) ? { token: ORIGIN } : null;
}

const areaOf = (v: BeelineVacancy): string => v.city?.map((c) => c.name).join(", ") || v.location_address || "";

const toDiscovered = (v: BeelineVacancy): Discovered => ({
  externalId: atsId("site:beeline", v.id),
  url: `${ORIGIN}/vacancies/${v.id}`,
  title: v.name,
  company: COMPANY,
  location: areaOf(v) || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let offset = 0;
  for (;;) {
    const page = await getJson<BeelineListPage>(`${LIST_API}?limit=${PAGE_SIZE}&offset=${offset}`);
    out.push(...page.results.map(toDiscovered));
    if (!page.next || page.results.length === 0) break;
    offset += PAGE_SIZE;
  }
  return out;
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const v = await getJson<BeelineVacancy>(`${LIST_API}${rawId(d.externalId)}`);
  return makeVacancy({
    source: "site:beeline",
    externalId: d.externalId,
    url: d.url,
    title: v.name || d.title,
    company: COMPANY,
    descriptionText: v.description ? stripHtml(decodeEntities(v.description)) : "",
    area: areaOf(v) || d.location || "",
    workFormat: (v.format ?? []).join(", "),
    salaryFrom: Number(v.gross_salary_from) || 0,
    salaryTo: Number(v.gross_salary_to) || 0,
    currency: v.gross_salary_from || v.gross_salary_to ? "RUR" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:beeline",
  verified: true,
  notes:
    "no public docs; public JSON API at /api/v1/vacancies/ (DRF pagination, list+detail, same field " +
    "shape) is Beeline's own aggregator over several upstream ATS (external_system_name: SKILLAZ, " +
    "POTOK, ...) - we read Beeline's unified endpoint, not the upstream systems; description is HTML, " +
    "gross salary in RUB when set, no currency field (assumed RUR); apply is a multi-step in-page form " +
    "(name/phone/email, resume file-or-link, OTP phone verification via /api/v1/create-otp + " +
    "/verify-otp/) with no documented public apply API -> agent flow only, no apply()",
  jobsUrl: () => `${LIST_API}?limit=${PAGE_SIZE}&offset=0`,
  detect,
  listJobs,
  fetchJob,
};
