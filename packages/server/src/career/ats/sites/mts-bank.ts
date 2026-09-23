// MTS Bank careers site (job.mtsbank.ru), a Next.js app whose vacancies page fetches client-side
// from a public Strapi-style REST API - no data embedded in the HTML/flight payload at all.
// Verified live 2026-09 (56 open vacancies, fits in one unpaginated page).
//   GET /api/career/vacancies?filters[deletedAt][$null]=true&populate=*&pagination[pageSize]=100
//     -> JSON {data:[{id,attributes:{name,externalId,introduction,duties,requirements,conditions,
//        salaryFrom,salaryTo,slug,location:{data:{attributes:{shortName}}},
//        specialization:{data:{attributes:{name}}}, ...}}], meta:{pagination:{total,pageCount}}}.
//     The endpoint with no filter also returns soft-deleted/archived postings (most of them), so
//     the deletedAt filter is required to get only live jobs; 100 comfortably covers the real
//     total (also cross-checked via meta.pagination.pageCount, looped just in case it grows).
//   GET /vacancies/{externalId} is the human page; detail data is refetched from
//     /api/career/vacancies/{id} (Strapi numeric id, not externalId) with the same shape.
// No salaryFrom/salaryTo populated in any live listing observed. Apply is a client-rendered
// "Откликнуться" form (behind a captcha) on the vacancy page - no public apply API, agent flow only.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.mtsbank.ru";
const API = `${ORIGIN}/api/career/vacancies`;
const COMPANY = "МТС Банк";
const PAGE_SIZE = 100;

interface MTSRelation<T> {
  data: { id: number; attributes: T } | null;
}

interface MTSVacancyAttrs {
  name: string;
  externalId: string;
  introduction?: string | null;
  duties?: string | null;
  requirements?: string | null;
  conditions?: string | null;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  slug: string;
  deletedAt: string | null;
  location?: MTSRelation<{ shortName?: string; name?: string }>;
  specialization?: MTSRelation<{ name?: string }>;
}

interface MTSVacancy {
  id: number;
  attributes: MTSVacancyAttrs;
}

interface MTSListResponse {
  data: MTSVacancy[];
  meta: { pagination: { page: number; pageCount: number; total: number } };
}

interface MTSDetailResponse {
  data: MTSVacancy;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "job.mtsbank.ru") return { token: ORIGIN };
  return /job\.mtsbank\.ru\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (externalId: string): string => `${ORIGIN}/vacancies/${externalId}`;

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:mts-bank" is itself
// two colon-segments, so we peel our own known prefix instead.
const KIND_PREFIX = "site:mts-bank:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

const locationOf = (v: MTSVacancyAttrs): string => v.location?.data?.attributes.shortName ?? v.location?.data?.attributes.name ?? "";

const toDiscovered = (v: MTSVacancy): Discovered => ({
  externalId: atsId("site:mts-bank", v.attributes.externalId),
  url: vacancyUrl(v.attributes.externalId),
  title: v.attributes.name.trim(),
  company: COMPANY,
  location: locationOf(v.attributes) || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const url = `${API}?filters[deletedAt][$null]=true&populate=*&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`;
    const data = await getJson<MTSListResponse>(url);
    for (const v of data.data) {
      if (seen.has(v.attributes.externalId)) continue;
      seen.add(v.attributes.externalId);
      out.push(toDiscovered(v));
    }
    if (page >= data.meta.pagination.pageCount) break;
  }
  return out;
}

const descriptionOf = (a: MTSVacancyAttrs): string =>
  [
    a.introduction,
    a.duties && `Обязанности:\n${a.duties}`,
    a.requirements && `Требования:\n${a.requirements}`,
    a.conditions && `Условия:\n${a.conditions}`,
  ]
    .filter((s): s is string => Boolean(s?.trim()))
    .join("\n\n");

async function fetchJob(_token: string, d: Discovered) {
  const cached = (d.raw as MTSVacancy | undefined)?.attributes;
  const id = cached?.externalId === localId(d.externalId) ? (d.raw as MTSVacancy).id : undefined;
  const attrs = id
    ? (await getJson<MTSDetailResponse>(`${API}/${id}?populate=*`)).data.attributes
    : cached ?? (await lookupByExternalId(localId(d.externalId)));
  return makeVacancy({
    source: "site:mts-bank",
    externalId: d.externalId,
    url: vacancyUrl(attrs.externalId),
    title: attrs.name.trim(),
    company: COMPANY,
    descriptionText: descriptionOf(attrs),
    area: locationOf(attrs),
    salaryFrom: attrs.salaryFrom ?? 0,
    salaryTo: attrs.salaryTo ?? 0,
  });
}

// Fallback when we only have the externalId (no cached Strapi numeric id, e.g. a Discovered built
// elsewhere): the list endpoint filters by it directly.
async function lookupByExternalId(externalId: string): Promise<MTSVacancyAttrs> {
  const url = `${API}?filters[externalId][$eq]=${encodeURIComponent(externalId)}&populate=*&pagination[pageSize]=1`;
  const data = await getJson<MTSListResponse>(url);
  const found = data.data[0];
  if (!found) throw new Error(`mts-bank: vacancy ${externalId} not found`);
  return found.attributes;
}

export const client: ATSClientImpl = {
  kind: "site:mts-bank",
  verified: true,
  notes:
    "no docs; public Strapi REST API GET /api/career/vacancies (filters[deletedAt][$null]=true " +
    "required - unfiltered response is mostly archived postings; populate=* for location/specialization); " +
    "detail via GET /api/career/vacancies/{id}?populate=*; no salary ever populated; apply is a " +
    "client-rendered form behind a captcha on the vacancy page, no public apply API -> agent flow only",
  jobsUrl: () => `${API}?filters[deletedAt][$null]=true&populate=*&pagination[pageSize]=${PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
