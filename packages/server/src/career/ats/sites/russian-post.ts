// Russian Post careers site. The given base_url career.pochta.ru does not resolve (DNS NXDOMAIN,
// verified 2026-09); the real listing lives on the main site at www.pochta.ru/vacancy-list, a
// Next.js app. No public docs; both endpoints below are the same JSON API the page's own React
// widget calls (found in the /_next/static/chunks/pages/vacancy-list-*.js bundle), confirmed live:
//   POST /api/jobs/api/v2/vacancies/filter?limit=&offset=  body {searchParams:[], query:""}
//     -> {content:[...], totalElements} (limit capped server-side at 100/page)
//   GET  /api/jobs/api/v2/vacancies/{id}                    -> full detail (same shape, no pagination)
// searchParams can filter by DIRECTION (values incl. "IT"), but as of 2026-09 that returns just one
// IT-support role out of ~6300 total (mostly post-office clerk/courier roles) - listJobs returns
// everything unfiltered per contract, the runner keyword-filters afterwards, same as other clients
// with a mostly-non-tech parent site (rzd.ts, cdek.ts). Canonical vacancy URL is /vacancy-list/{id}.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, postJson } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://www.pochta.ru";
const LIST_API = `${ORIGIN}/api/jobs/api/v2/vacancies/filter`;
const DETAIL_API = `${ORIGIN}/api/jobs/api/v2/vacancies`;
const PAGE_SIZE = 100;
const COMPANY = "Почта России";

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:russian-post" is itself
// two colon-segments, so peel our own known prefix instead (same fix as sites/rzd.ts, beeline.ts).
const KIND_PREFIX = "site:russian-post:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

const SCHEDULE_LABELS: Record<string, string> = {
  FULL_DAY: "Полный день",
  SHIFT: "Сменный график",
  FLEXIBLE: "Гибкий график",
};

export interface RPVacancy {
  id: number;
  jobName: string;
  addressLocation?: string | null;
  shortDescription?: string;
  salary?: number | null;
  schedule?: string | null;
  requirements?: string | null;
  responsibilities?: string | null;
  conditions?: string | null;
}

interface RPListResponse {
  content: RPVacancy[];
  totalElements: number;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "www.pochta.ru" || hostOf(baseUrl) === "pochta.ru") return { token: ORIGIN };
  return /pochta\.ru\/(vacancy-list|api\/jobs\/api\/v2\/vacancies)/i.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (id: number | string): string => `${ORIGIN}/vacancy-list/${id}`;

const toDiscovered = (v: RPVacancy): Discovered => ({
  externalId: atsId("site:russian-post", v.id),
  url: vacancyUrl(v.id),
  title: v.jobName,
  company: COMPANY,
  location: v.addressLocation || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await postJson<RPListResponse>(`${LIST_API}?limit=${PAGE_SIZE}&offset=${offset}`, { searchParams: [], query: "" });
    const items = page.content ?? [];
    out.push(...items.map(toDiscovered));
    if (items.length === 0 || offset + items.length >= page.totalElements) break;
  }
  return out;
}

function descriptionOf(v: RPVacancy): string {
  const section = (title: string, text?: string | null) => (text ? `${title}:\n${text.trim()}` : "");
  return [section("Обязанности", v.responsibilities), section("Требования", v.requirements), section("Условия", v.conditions), v.shortDescription ?? ""]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const v = await getJson<RPVacancy>(`${DETAIL_API}/${localId(d.externalId)}`);
  return makeVacancy({
    source: "site:russian-post",
    externalId: d.externalId,
    url: d.url,
    title: v.jobName ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.addressLocation || d.location || "",
    workFormat: (v.schedule && SCHEDULE_LABELS[v.schedule]) || "",
    salaryFrom: v.salary ?? 0,
    currency: v.salary ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:russian-post",
  verified: true,
  notes:
    "given base_url career.pochta.ru does not resolve; real listing is www.pochta.ru/vacancy-list. " +
    "List via POST /api/jobs/api/v2/vacancies/filter?limit=&offset= (body {searchParams:[],query:''}, " +
    "public JSON, no auth, limit capped at 100/page server-side); ~6300 open vacancies as of 2026-09, " +
    "almost all post-office/logistics field roles - a DIRECTION:IT searchParam filter exists but " +
    "returns only 1 role, so listJobs returns everything unfiltered per contract and the runner " +
    "keyword-filters. Detail via GET /api/jobs/api/v2/vacancies/{id} (same public JSON API, no salary " +
    "range - single 'salary' figure). Apply is a client-rendered form (name, phone, email, resume " +
    "upload) posted to POST .../feedback found in the same bundle - not inspected past that point, " +
    "no public JSON apply payload confirmed -> agent flow only, no apply() implemented.",
  jobsUrl: () => `${LIST_API}?limit=${PAGE_SIZE}&offset=0`,
  detect,
  listJobs,
  fetchJob,
};
