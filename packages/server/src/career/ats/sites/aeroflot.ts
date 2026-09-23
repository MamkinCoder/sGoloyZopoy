// Aeroflot careers site (vacancy.aeroflot.ru; job.aeroflot.ru from the brief does not resolve).
// An Angular SPA with no server-rendered content, but its own JSON API (found by reading the
// bundled main.*.js: PublicVacancies/PublicDictionaries REST controllers) is public and unauthenticated.
// Verified live 2026-09:
//   POST /api/PublicVacancies/items   body {data:{categoriesIds:[N],cityId,departmentId,searchText},
//                                     orderOptions:{column,direction},pagingOptions:{pageNumber,pageSize}}
//                                     -> {totalCount,count,data:[{id,categoryId,cityName,name,
//                                        descriptionBlocks:[{name,content}],...}]}
//   POST /api/PublicVacancies/getById body {data:{vacancyId}} -> same shape, single {data}
//   POST /api/PublicDictionaries/Categories -> the 8 category ids (Flight crew, Flight attendants,
//                                     Engineering staff, Branches, Medical, Ground handling, Disability
//                                     jobs, Other)
// Two quirks confirmed live: (1) the LanguageId header MUST be a language code ("RU"), not a number -
// sending anything else (including omitting it) makes /items silently return zero results with HTTP 200.
// (2) passing more than one id in categoriesIds also silently returns zero results (looks like the
// server ANDs the ids instead of ORing them), so listJobs queries every category id separately and
// merges. Detail page in the browser is the SPA route /ru-ru/view?id={id}&categoryId={categoryId}, but
// getById already returns full descriptionBlocks so fetchJob doesn't need to scrape it. No salary field
// anywhere in the API. Apply is the SPA's own /ru-ru/form/{vacancyId} multi-step wizard (resume upload +
// personal data), no public JSON apply API found -> apply() omitted, agent flow only.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const KIND = "site:aeroflot";
const ORIGIN = "https://vacancy.aeroflot.ru";
const API = `${ORIGIN}/api`;
const COMPANY = "Aeroflot";
const PAGE_SIZE = 100;

const HEADERS = {
  "content-type": "application/json;odata=verbose",
  accept: "application/json;odata=verbose",
  languageid: "RU",
};

async function postApi<T>(path: string, body: unknown): Promise<T> {
  return getJson<T>(`${API}/${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
}

interface AflVacancy {
  id: number;
  categoryId: number;
  cityName?: string;
  cityId?: number;
  name: string;
  descriptionBlocks?: { name: string; content: string }[];
}

interface AflItemsResponse {
  totalCount: number;
  data: AflVacancy[];
}

interface AflCategory {
  id: number;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "vacancy.aeroflot.ru") return { token: ORIGIN };
  return /PublicVacancies\/items|vacancy\.aeroflot\.ru/i.test(html) ? { token: ORIGIN } : null;
}

const detailUrl = (id: number, categoryId: number): string => `${ORIGIN}/ru-ru/view?id=${id}&categoryId=${categoryId}`;

const toDiscovered = (v: AflVacancy): Discovered => ({
  externalId: atsId(KIND, v.id),
  url: detailUrl(v.id, v.categoryId),
  title: v.name,
  company: COMPANY,
  location: v.cityName || undefined,
  raw: v,
});

async function itemsForCategory(categoryId: number): Promise<AflVacancy[]> {
  const res = await postApi<AflItemsResponse>("PublicVacancies/items", {
    data: { categoriesIds: [categoryId], cityId: null, departmentId: null, searchText: "" },
    orderOptions: { column: "changedOn", direction: "desc" },
    pagingOptions: { pageNumber: 1, pageSize: PAGE_SIZE },
  });
  return res.data ?? [];
}

async function listJobs(): Promise<Discovered[]> {
  const categories = await postApi<{ data: AflCategory[] }>("PublicDictionaries/Categories", {
    data: {},
    sortingOptions: { direction: "Desc", column: "name" },
  });
  const seen = new Map<string, Discovered>();
  for (const cat of categories.data ?? []) {
    for (const v of await itemsForCategory(cat.id)) {
      const d = toDiscovered(v);
      seen.set(d.externalId, d);
    }
  }
  return [...seen.values()];
}

function descriptionOf(v: AflVacancy): string {
  return (v.descriptionBlocks ?? [])
    .map((b) => stripHtml(b.content))
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const res = await postApi<{ data: AflVacancy }>("PublicVacancies/getById", {
    data: { vacancyId: Number(rawId(d.externalId)) },
  });
  const v = res.data;
  return makeVacancy({
    source: KIND,
    externalId: d.externalId,
    url: d.url,
    title: v?.name ?? d.title,
    company: COMPANY,
    descriptionText: v ? descriptionOf(v) : "",
    area: v?.cityName ?? d.location ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: KIND,
  verified: true,
  notes:
    "Angular SPA at vacancy.aeroflot.ru (job.aeroflot.ru from the brief does not resolve); its own " +
    "public JSON API: POST /api/PublicVacancies/items (list, per-category - the server ANDs multiple " +
    "categoriesIds into zero results so listJobs queries the 8 categories from " +
    "/api/PublicDictionaries/Categories separately and merges) and POST /api/PublicVacancies/getById " +
    "(detail, full descriptionBlocks). Requires header LanguageId: RU exactly - any other value " +
    "(including a numeric id) makes items silently return zero results with HTTP 200. No salary field " +
    "in the API. Only 4 vacancies open company-wide as of 2026-09, none software-dev (flight crew " +
    "reserve form, flight attendants intro, ground handling agent, general internship program). Apply " +
    "is the SPA's own multi-step /ru-ru/form/{vacancyId} wizard (resume upload + personal data), no " +
    "public JSON apply API found -> agent flow only.",
  jobsUrl: () => `${API}/PublicVacancies/items`,
  detect,
  listJobs,
  fetchJob,
};
