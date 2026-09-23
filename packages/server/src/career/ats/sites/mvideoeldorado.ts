// М.Видео-Эльдорадо careers site (career.mvideoeldorado.ru), a Next.js app. The pages are
// server-rendered shells; the real listing/detail come from a public JSON API on a separate host
// found in the page's JS chunks (verified live 2026-09):
//   GET https://career-site-api.mvideoeldorado.ru/v1/vacancies/search?page=  -> list, page_size fixed
//                                                                                at 10 by the server
//   GET https://career-site-api.mvideoeldorado.ru/v1/vacancy/{external_id}   -> detail
// No auth, no board token. Canonical vacancy URL is /vacancies/{external_id}. 153 open vacancies as
// of 2026-09, almost all retail (Магазин/Склад и Логистика); the "ИТ" direction filter currently
// shows 0 (per GET /v1/vacancies/filter_options), so listJobs returns everything unfiltered like
// the other site clients and the runner's keyword filter decides relevance.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const SITE_ORIGIN = "https://career.mvideoeldorado.ru";
const API_ORIGIN = "https://career-site-api.mvideoeldorado.ru";
const LIST_API = `${API_ORIGIN}/v1/vacancies/search`;
const DETAIL_API = `${API_ORIGIN}/v1/vacancy`;
const COMPANY = "М.Видео-Эльдорадо";

// rawId() from ../types.ts strips one "[a-z_]+:" segment, but our kind "site:mvideoeldorado" is
// itself two colon-segments, so we peel our own known prefix instead (same issue as sites/rostelecom.ts).
const KIND_PREFIX = "site:mvideoeldorado:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

export interface MVEListItem {
  external_id: string;
  title: string;
  work_location?: string;
  city_name?: string;
  direction?: string;
  salary_to?: number | null;
  currency?: string;
  active?: boolean;
}

interface MVESearchResponse {
  data: MVEListItem[];
  pagination: { page: number; page_size: number; total_pages: number; total_count: number };
}

export interface MVEVacancy {
  external_id: string;
  title: string;
  city_name?: string;
  work_location?: string;
  salary_from?: number | null;
  salary_to?: number | null;
  currency?: string;
  work_formats?: string[];
  employment_types?: string[];
  description?: string;
  responsibility_prof?: string;
  requirements_prof?: string;
  offer_prof?: string;
}

interface MVEDetailResponse {
  vacancy: MVEVacancy;
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "career.mvideoeldorado.ru" ? { token: SITE_ORIGIN } : null;
}

const vacancyUrl = (externalId: string): string => `${SITE_ORIGIN}/vacancies/${externalId}`;

const toDiscovered = (v: MVEListItem): Discovered => ({
  externalId: atsId("site:mvideoeldorado", v.external_id),
  url: vacancyUrl(v.external_id),
  title: v.title,
  company: COMPANY,
  location: v.city_name || v.work_location || undefined,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let page = 1; ; page++) {
    const data = await getJson<MVESearchResponse>(`${LIST_API}?page=${page}`);
    const items = data.data ?? [];
    out.push(...items.map(toDiscovered));
    if (items.length === 0 || out.length >= (data.pagination?.total_count ?? 0)) break;
  }
  return out;
}

function descriptionOf(v: MVEVacancy): string {
  const section = (title: string, html?: string) => {
    const text = stripHtml(html ?? "");
    return text ? `${title}:\n${text}` : "";
  };
  return [
    stripHtml(v.description ?? ""),
    section("Обязанности", v.responsibility_prof),
    section("Требования", v.requirements_prof),
    section("Условия", v.offer_prof),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const res = await getJson<MVEDetailResponse>(`${DETAIL_API}/${localId(d.externalId)}`);
  const v = res.vacancy;
  return makeVacancy({
    source: "site:mvideoeldorado",
    externalId: d.externalId,
    url: d.url,
    title: v.title ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.city_name || v.work_location || d.location || "",
    workFormat: (v.work_formats ?? []).join(", "),
    salaryFrom: v.salary_from ?? 0,
    salaryTo: v.salary_to ?? 0,
    currency: v.salary_from || v.salary_to ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:mvideoeldorado",
  verified: true,
  notes:
    "public JSON API on a separate host, no auth: GET career-site-api.mvideoeldorado.ru/v1/vacancies/search?page= " +
    "(page_size fixed server-side at 10, 153 open vacancies as of 2026-09, listJobs returns all unfiltered) and " +
    "GET /v1/vacancy/{external_id} for detail (description/responsibility_prof/requirements_prof/offer_prof as HTML); " +
    "direction filter (?directions=ИТ) currently returns 0 per /v1/vacancies/filter_options, almost all open roles " +
    "are retail (Магазин, Склад и Логистика); apply requires an authenticated profile (phone code confirm), no " +
    "public unauthenticated apply endpoint found -> agent flow only",
  jobsUrl: () => `${LIST_API}?page=1`,
  detect,
  listJobs,
  fetchJob,
};
