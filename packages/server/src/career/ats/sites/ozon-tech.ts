// Ozon Tech careers site (ozon.tech), the tech brand for Ozon's whole "digital ecosystem" (fresh,
// Банк, Логистика, Фулфилмент, Офис и Коммерция, ... post through the same portal, each vacancy's
// `dep`/`department` says which). The site itself (ozon.tech, job.ozon.ru, even /robots.txt) sits
// behind a JS "Ozon Antibot" challenge page on every plain GET - no HTML route is fetchable without
// a browser. But the API it calls from, job-api.ozon.ru, is a separate host with no antibot check:
// public JSON, no auth, confirmed live 2026-09 (2099 vacancies across all of Ozon; 300 under the
// "Ozon Tech" department filter, mixing dev roles with warehouse/support/КИПиА roles under that
// department - unfiltered, per contract, the runner filters by keyword).
//   GET /vacancy?department=Ozon%20Tech&limit=50&page=<n>  -> JSON {items:[{hhId,title,city,
//     department,employment,experience,workFormat,professionalRoles,internalUuid,...}],
//     meta:{limit,page,perPage,totalItems,totalPages}}. limit is capped at 50 server-side (a
//     larger value silently returns 50); department is exact-match on the value from GET /filters
//     (filters.departments includes "Ozon Tech" alongside fresh/Банк/Логистика/...).
//   GET /vacancy/{hhId}  -> JSON detail: {name,dep,city,descr (sanitized HTML),exp,employment,
//     salary:{from,to,currency},workFormat,slug,...}. No live salary observed (from/to always 0).
//     Detail's own "hhId" field is always 0 (unused); the id from the list is the one that resolves.
// No public front-end route could be verified (every ozon.tech HTML path, including /robots.txt,
// redirects into the antibot challenge), so the vacancy URL is built from the API's own `slug`
// field (e.g. "c-razrabotchik-135781631") as /vacancy/{slug}, matching the API's own path shape.
// No public apply API found; apply is presumably a client-rendered form behind the antibot wall,
// so apply() is omitted - agent flow only, and even the agent flow will need the antibot solved.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const SITE_ORIGIN = "https://ozon.tech";
const API = "https://job-api.ozon.ru";
const DEPARTMENT = "Ozon Tech";
const PAGE_SIZE = 50;
const COMPANY = "Ozon";

interface OzonProfessionalRole {
  ID: string;
  title: string;
}

interface OzonListItem {
  hhId: number;
  title: string;
  city?: string;
  department?: string;
  employment?: string;
  experience?: string;
  workFormat?: string[];
  professionalRoles?: OzonProfessionalRole[];
  vacancyType?: string;
}

interface OzonListResponse {
  items: OzonListItem[];
  meta: { limit: number; page: number; perPage: number; totalItems: number; totalPages: number };
}

interface OzonSalary {
  from?: number | null;
  to?: number | null;
  currency?: string | null;
}

interface OzonDetail {
  name: string;
  dep?: string;
  city?: string;
  descr?: string;
  employment?: string;
  salary?: OzonSalary;
  workFormat?: string[];
  slug?: string;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "ozon.tech" || hostOf(baseUrl) === "job.ozon.ru") return { token: SITE_ORIGIN };
  return /job-api\.ozon\.ru\/vacanc/i.test(html) ? { token: SITE_ORIGIN } : null;
}

const vacancyUrl = (slug: string): string => `${SITE_ORIGIN}/vacancy/${slug}`;
const fallbackSlug = (hhId: number): string => String(hhId);

const toDiscovered = (v: OzonListItem): Discovered => ({
  externalId: atsId("site:ozon-tech", v.hhId),
  url: vacancyUrl(fallbackSlug(v.hhId)),
  title: v.title.trim(),
  company: COMPANY,
  location: v.city?.trim() || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let page = 1; page <= 50; page++) {
    const data = await getJson<OzonListResponse>(
      `${API}/vacancy?department=${encodeURIComponent(DEPARTMENT)}&limit=${PAGE_SIZE}&page=${page}`,
    );
    out.push(...data.items.map(toDiscovered));
    if (page >= data.meta.totalPages || data.items.length === 0) break;
  }
  return out;
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const hhId = Number(d.externalId.split(":").pop());
  const v = await getJson<OzonDetail>(`${API}/vacancy/${hhId}`);
  const url = v.slug ? vacancyUrl(v.slug) : d.url;
  return makeVacancy({
    source: "site:ozon-tech",
    externalId: d.externalId,
    url,
    title: v.name?.trim() || d.title,
    company: COMPANY,
    descriptionText: v.descr ? stripHtml(v.descr) : "",
    area: v.city?.trim() || d.location || "",
    workFormat: v.workFormat?.join(", ") ?? "",
    salaryFrom: v.salary?.from ?? 0,
    salaryTo: v.salary?.to ?? 0,
    currency: v.salary?.currency ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:ozon-tech",
  verified: true,
  notes:
    "ozon.tech itself (and job.ozon.ru, even /robots.txt) sits behind a JS antibot challenge on every " +
    "plain GET, so no HTML route was fetchable to confirm; instead uses the public JSON API the site " +
    "calls from, job-api.ozon.ru (no antibot, no auth). GET /vacancy?department=Ozon%20Tech&limit=50&page=n " +
    "(300 vacancies under this department on 2026-09, mixing dev roles with warehouse/support/КИПиА - " +
    "unfiltered per contract); limit caps at 50/page server-side. Detail via GET /vacancy/{hhId} " +
    "(sanitized HTML description, workFormat, salary - no live salary observed, always 0). Vacancy URL " +
    "is built from the detail's own slug field (unverified against a real front-end route, since every " +
    "ozon.tech page is behind the antibot wall). No public apply API found -> agent flow only, and the " +
    "agent will still need to solve the antibot challenge to reach the apply page.",
  jobsUrl: () => `${API}/vacancy?department=${encodeURIComponent(DEPARTMENT)}&limit=${PAGE_SIZE}&page=1`,
  detect,
  listJobs,
  fetchJob,
};
