// MegaFon careers site — a React SPA served at job.megafon.ru (career.megafon.ru does not resolve).
// No public docs; endpoints found by reading the initial page's __INITIAL_STATE__ and the SPA's
// main JS bundle. Verified live 2026-09 (1012 open vacancies).
//   GET /api/v1/vacancies?page={n}            -> JSON {page,pages,total,vacancies:[{id,title,slug,
//                                                  city:{id,title},sector:{id,title,slug},specialties,
//                                                  publishedAt,organisation:{id,title}}]}, fixed page
//                                                  size 10, no filter query params observed (sectorId
//                                                  param exists but list is small enough to just page).
//   GET /api/v1/vacancies/{slug}?cityId={id}  -> JSON full detail: description/requirements/conditions
//                                                  are HTML, city, experience, specialties, workingSchedule,
//                                                  sector, keySkills, minSalary/maxSalary (null in every
//                                                  listing observed). cityId is required (400 without it)
//                                                  and comes from the list item's city.id.
// Apply is POST /api/v1/vacancies/{slug}/apply/{type} (multipart, resume + fields), client-rendered
// button, no login seen but a captcha endpoint exists (/api/v1/captcha/get/) — agent flow only.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.megafon.ru";
const API = `${ORIGIN}/api/v1/vacancies`;
const COMPANY = "МегаФон";

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:megafon" is itself two
// colon-segments, so we peel our own known prefix instead (same issue as sites/mts-bank.ts).
const KIND_PREFIX = "site:megafon:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

interface MFCity {
  id: number;
  title: string;
  slug?: string;
}

interface MFListItem {
  id: number;
  title: string;
  slug: string;
  city: MFCity;
  sector?: { id: number; title: string; slug?: string };
  specialties?: string[];
  publishedAt?: number;
}

interface MFListResponse {
  page: number;
  pages: number;
  total: number;
  vacancies: MFListItem[];
}

interface MFDetail {
  id: number;
  title: string;
  publishedAt?: number;
  minSalary?: number | null;
  maxSalary?: number | null;
  description?: string | null;
  requirements?: string | null;
  conditions?: string | null;
  city?: MFCity;
  experience?: string;
  specialties?: string[];
  workingSchedule?: string;
  slug: string;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "job.megafon.ru") return { token: ORIGIN };
  return /job\.megafon\.ru\/api\/v1\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (slug: string): string => `${ORIGIN}/vacancy/${slug}`;

const toDiscovered = (v: MFListItem): Discovered => ({
  externalId: atsId("site:megafon", v.slug),
  url: vacancyUrl(v.slug),
  title: v.title,
  company: COMPANY, // list carries organisation.title (e.g. МегаТех for subsidiaries) but we report the parent brand
  location: v.city.title || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  const first = await getJson<MFListResponse>(`${API}?page=1`);
  out.push(...first.vacancies.map(toDiscovered));
  for (let page = 2; page <= first.pages; page++) {
    const data = await getJson<MFListResponse>(`${API}?page=${page}`);
    out.push(...data.vacancies.map(toDiscovered));
  }
  return out;
}

const descriptionOf = (d: MFDetail): string =>
  [
    d.description && stripHtml(d.description),
    d.requirements && `Требования:\n${stripHtml(d.requirements)}`,
    d.conditions && `Условия:\n${stripHtml(d.conditions)}`,
  ]
    .filter((s): s is string => Boolean(s?.trim()))
    .join("\n\n");

async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as MFListItem | undefined;
  const cityId = cached?.city.id ?? "";
  const detail = await getJson<MFDetail>(`${API}/${localId(d.externalId)}?cityId=${cityId}`);
  return makeVacancy({
    source: "site:megafon",
    externalId: d.externalId,
    url: d.url,
    title: detail.title ?? cached?.title ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(detail),
    area: detail.city?.title ?? cached?.city.title ?? d.location ?? "",
    workFormat: detail.workingSchedule ?? "",
    salaryFrom: detail.minSalary ?? 0,
    salaryTo: detail.maxSalary ?? 0,
  });
}

export const client: ATSClientImpl = {
  kind: "site:megafon",
  verified: true,
  notes:
    "no public docs; React SPA at job.megafon.ru (career.megafon.ru does not resolve); list via " +
    "GET /api/v1/vacancies?page={n} (fixed page size 10, no keyword filter used); detail via " +
    "GET /api/v1/vacancies/{slug}?cityId={id} (cityId required, taken from the list item); " +
    "minSalary/maxSalary null in every listing observed; apply is a client-rendered form posting " +
    "multipart to /api/v1/vacancies/{slug}/apply/{type}, a captcha endpoint exists — agent flow only",
  jobsUrl: () => `${API}?page=1`,
  detect,
  listJobs,
  fetchJob,
};
