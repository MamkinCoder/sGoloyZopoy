// Lenta careers site (career.lenta.com), a Next.js static export whose vacancy widget calls a
// public JSON API on a separate host (found in the widget's JS chunk, verified live 2026-09):
//   GET https://lenta-career-api.k8s.axes.pro/api/v1/search/table/?cityId=&countItemsPerPage=
//     -> filters (all cities with open-vacancy counts) + paginated results for that one city.
// The API has no "all cities" mode: cityId is required and a call without it (or with bds/key alone)
// silently returns zero results, so listJobs first reads the unfiltered call for the city list+counts,
// then does one call per city with count > 0 (countItemsPerPage=1000 gets each city in a single page -
// the biggest city, Saint Petersburg, has ~600 vacancies). List items already carry full HTML
// responsibilities/requirements/conditions identical to the /v1/search/vacancy-by-id/{id} detail
// endpoint, so fetchJob reuses the cached payload from listJobs with no extra request.
// Vacancy pages are client-rendered at /jobapply/{id} (the apply form route; there is no separate
// read-only detail route in the SPA, so it doubles as the canonical vacancy URL).
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const SITE_ORIGIN = "https://career.lenta.com";
const API = "https://lenta-career-api.k8s.axes.pro/api";
const SEARCH_TABLE = `${API}/v1/search/table/`;
const PAGE_SIZE = 1000;

interface LentaCity {
  cityId: number;
  title: string;
  count: number;
}

export interface LentaVacancy {
  vacancyId: number;
  title: string;
  responsibilities?: string;
  requirements?: string;
  conditions?: string;
  cityId: number;
  cityTitle?: string;
  addressTitle?: string;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  businessDirectionTitle?: string;
  isHideOnCareer?: boolean;
}

interface SearchTableResponse {
  filters: { cities: LentaCity[] };
  searchResult: { items: LentaVacancy[] };
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "career.lenta.com" ? { token: SITE_ORIGIN } : null;
}

const vacancyUrl = (id: number | string): string => `${SITE_ORIGIN}/jobapply/${id}`;

const toDiscovered = (v: LentaVacancy): Discovered => ({
  externalId: atsId("site:lenta", v.vacancyId),
  url: vacancyUrl(v.vacancyId),
  title: v.title.trim(),
  company: "Lenta",
  location: v.cityTitle || v.addressTitle || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const first = await getJson<SearchTableResponse>(`${SEARCH_TABLE}?countItemsPerPage=${PAGE_SIZE}`);
  const cities = (first.filters?.cities ?? []).filter((c) => c.count > 0);
  const seen = new Map<number, LentaVacancy>();
  for (const v of first.searchResult?.items ?? []) seen.set(v.vacancyId, v);
  for (const city of cities) {
    const page = await getJson<SearchTableResponse>(`${SEARCH_TABLE}?cityId=${city.cityId}&countItemsPerPage=${PAGE_SIZE}`);
    for (const v of page.searchResult?.items ?? []) seen.set(v.vacancyId, v);
  }
  return [...seen.values()].filter((v) => !v.isHideOnCareer).map(toDiscovered);
}

function descriptionOf(v: LentaVacancy): string {
  const section = (title: string, html?: string) => {
    const text = stripHtml(html ?? "");
    return text ? `${title}:\n${text}` : "";
  };
  return [section("Обязанности", v.responsibilities), section("Требования", v.requirements), section("Условия", v.conditions)]
    .filter(Boolean)
    .join("\n\n");
}

// listJobs's payload already carries the full description, so fetchJob reuses it; it only re-fetches
// by id as a fallback (e.g. Discovered.raw missing).
async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as LentaVacancy | undefined;
  const v = cached ?? (await getJson<LentaVacancy>(`${API}/v1/search/vacancy-by-id/${rawId(d.externalId)}`));
  return makeVacancy({
    source: "site:lenta",
    externalId: d.externalId,
    url: d.url,
    title: v.title?.trim() ?? d.title,
    company: "Lenta",
    descriptionText: descriptionOf(v),
    area: v.cityTitle || v.addressTitle || d.location || "",
    salaryFrom: v.salaryFrom ?? 0,
    salaryTo: v.salaryTo ?? 0,
    currency: v.salaryFrom || v.salaryTo ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:lenta",
  verified: true,
  notes:
    "public JSON API, no auth: GET lenta-career-api.k8s.axes.pro/api/v1/search/table/?cityId=&countItemsPerPage= " +
    "(cityId is required - omitting it, or filtering by bds/key alone, returns zero results, so listJobs first " +
    "reads the unfiltered call for the city+count list, then one call per city with count > 0; ~3500 total " +
    "vacancies across ~260 cities as of 2026-09, listJobs returns all unfiltered, most are retail/warehouse " +
    "(businessDirectionTitle Магазин/Производство/Распределительный центр) with only a handful under Офис); " +
    "list items already include full HTML responsibilities/requirements/conditions matching the " +
    "/v1/search/vacancy-by-id/{id} detail endpoint, so fetchJob reuses the cached payload from listJobs; " +
    "vacancy url is /jobapply/{id} on career.lenta.com (client-rendered, doubles as the apply form); apply is " +
    "POST /v1/negotiations (name, birth date, phone, city, citizenship, vacancyId) with no captcha seen in the " +
    "form bundle but not confirmed past that -> agent flow only, no apply() implemented here",
  jobsUrl: () => `${SEARCH_TABLE}?countItemsPerPage=${PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
