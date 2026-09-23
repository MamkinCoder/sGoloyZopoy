// MTS careers site (job.mts.ru), a Nuxt SPA covering the whole "digital ecosystem" (MTS itself,
// MTS Bank, RTK retail, and other MTS-group brands post through the same portal, each vacancy's
// `organization.title` says which). No docs; endpoint found in window.__NUXT__.config.public on the
// page and confirmed live 2026-09 (2526 open vacancies across all brands/functions on 2026-09-23).
//   GET /api/v2/vacancies?pagination[page]=&pagination[pageSize]=  -> public JSON, Strapi-style
//     {data:[{id,slug,title,salaryFrom,salaryTo,organization:{title},region:{title},
//     categories:[{title}]}], meta:{pagination:{page,pageCount,total}}}. No auth needed despite an
//     apiKey also present in that config (unused by this endpoint; likely for a different internal
//     API surface).
//   GET /api/v2/vacancies/{slug}  -> public JSON detail: {data:{title,salaryMin,salaryMax,
//     organization:{title},region:{title},info:[{label,value}] (Город/График/Опыт работы/...),
//     detailText:{description,descriptionOfProject,requirements,conditions}}}.
// No apply API found; apply is client-rendered ("Откликнуться") on the vacancy page, likely behind
// login/captcha like the other MTS-group sites -> agent flow only, apply() omitted.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.mts.ru";
const API = `${ORIGIN}/api/v2/vacancies`;
const PAGE_SIZE = 100;
const COMPANY_FALLBACK = "МТС";

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:mts" is itself two
// colon-segments, so we peel our own known prefix instead (same trick as sites/mts-bank.ts).
const KIND_PREFIX = "site:mts:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

interface MTSTitled {
  title?: string | null;
}

interface MTSListItem {
  id: number;
  slug: string;
  title: string;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  organization?: MTSTitled | null;
  region?: MTSTitled | null;
  categories?: MTSTitled[];
}

interface MTSListResponse {
  data: MTSListItem[];
  meta: { pagination: { page: number; pageCount: number; total: number } };
}

interface MTSInfoRow {
  label?: string | null;
  value?: string | null;
}

interface MTSVacancyDetail {
  slug: string;
  title: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  organization?: MTSTitled | null;
  region?: MTSTitled | null;
  info?: MTSInfoRow[];
  detailText?: {
    description?: string | null;
    descriptionOfProject?: string | null;
    requirements?: string | null;
    conditions?: string | null;
  } | null;
}

interface MTSDetailResponse {
  data: MTSVacancyDetail;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "job.mts.ru") return { token: ORIGIN };
  return /job\.mts\.ru\/api\/v2\/vacancies/.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (slug: string): string => `${ORIGIN}/vacancy/${slug}`;

const companyOf = (o: MTSTitled | null | undefined): string => o?.title?.trim() || COMPANY_FALLBACK;

const toDiscovered = (v: MTSListItem): Discovered => ({
  externalId: atsId("site:mts", v.slug),
  url: vacancyUrl(v.slug),
  title: v.title.trim(),
  company: companyOf(v.organization),
  location: v.region?.title?.trim() || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let page = 1; page <= 200; page++) {
    const data = await getJson<MTSListResponse>(`${API}?pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`);
    out.push(...data.data.map(toDiscovered));
    if (page >= data.meta.pagination.pageCount || data.data.length === 0) break;
  }
  return out;
}

const infoValue = (info: MTSInfoRow[] | undefined, label: string): string =>
  info?.find((r) => r.label?.trim() === label)?.value?.trim() ?? "";

function descriptionOf(v: MTSVacancyDetail): string {
  const t = v.detailText;
  return [t?.descriptionOfProject, t?.description, t?.requirements && `Требования:\n${t.requirements}`, t?.conditions && `Условия:\n${t.conditions}`]
    .filter((s): s is string => Boolean(s?.trim()))
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const res = await getJson<MTSDetailResponse>(`${API}/${localId(d.externalId)}`);
  const v = res.data;
  return makeVacancy({
    source: "site:mts",
    externalId: d.externalId,
    url: vacancyUrl(v.slug ?? localId(d.externalId)),
    title: v.title?.trim() || d.title,
    company: companyOf(v.organization) || d.company,
    descriptionText: descriptionOf(v),
    area: v.region?.title?.trim() || infoValue(v.info, "Город") || d.location || "",
    workFormat: infoValue(v.info, "График"),
    salaryFrom: v.salaryMin ?? 0,
    salaryTo: v.salaryMax ?? 0,
  });
}

export const client: ATSClientImpl = {
  kind: "site:mts",
  verified: true,
  notes:
    "no docs; public Strapi-style REST API GET /api/v2/vacancies?pagination[page]&pagination[pageSize] " +
    "(2526 vacancies live on 2026-09, all MTS-group brands mixed together - organization.title says which); " +
    "detail via GET /api/v2/vacancies/{slug}, plain-text sections in detailText + info[] rows for " +
    "city/schedule/experience; no public apply API found, apply button is client-rendered -> agent flow only",
  jobsUrl: () => `${API}?pagination[page]=1&pagination[pageSize]=${PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
