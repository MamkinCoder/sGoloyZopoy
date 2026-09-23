// Selectel careers site (selectel.ru/careers/), a Nuxt SPA. No docs; the API path was found in the
// SSR error message baked into the page's __NUXT_DATA__ when the upstream rate-limited a prerender:
// "[GET] \"https://api.selectel.ru/proxy/public/employee/api/public/vacancies?...\": 429". Verified
// live 2026-09 (23 open vacancies, fits in one unpaginated page).
//   GET https://api.selectel.ru/proxy/public/employee/api/public/vacancies?per_page=1000&page=1&brand=selectel
//     -> JSON {item_count, items:[{id,title,city:{name},tag:{name,description},timetable_mode:{name},
//        is_remote_available,is_hot,published_at}]}. No salary. tag.name is a department code
//        (backend/admin/sec/dcops/... - not filtered here, the runner filters by keyword).
//   GET https://api.selectel.ru/proxy/public/employee/api/public/vacancies/{id}
//     -> same fields plus detailed_desc (HTML) and conditions (HTML, often null).
// Human page is https://selectel.ru/careers/all/vacancy/{id}/. No salary anywhere. Apply button is
// a client-rendered form on that page behind no visible captcha, but no public apply API was found
// (only the vacancies read endpoints appear in the bundle) -> agent flow only, apply() omitted.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const SITE_ORIGIN = "https://selectel.ru";
const API = "https://api.selectel.ru/proxy/public/employee/api/public/vacancies";
const COMPANY = "Selectel";
const PER_PAGE = 1000;

interface SelLabel {
  id: number;
  name: string;
  description?: string;
}

interface SelVacancy {
  id: number;
  title: string;
  city?: SelLabel | null;
  tag?: SelLabel | null;
  timetable_mode?: SelLabel | null;
  is_remote_available?: boolean;
  detailed_desc?: string | null;
  conditions?: string | null;
}

interface SelListResponse {
  item_count: number;
  items: SelVacancy[];
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "selectel.ru" && /\/careers\b/.test(new URL(baseUrl).pathname)) return { token: SITE_ORIGIN };
  return /selectel\.ru\/careers\/all\/vacancy\//i.test(html) ? { token: SITE_ORIGIN } : null;
}

const vacancyUrl = (id: number | string): string => `${SITE_ORIGIN}/careers/all/vacancy/${id}/`;

const toDiscovered = (v: SelVacancy): Discovered => ({
  externalId: atsId("site:selectel", v.id),
  url: vacancyUrl(v.id),
  title: v.title.trim(),
  company: COMPANY,
  location: v.city?.name || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const data = await getJson<SelListResponse>(`${API}?per_page=${PER_PAGE}&page=1&brand=selectel`);
  return data.items.map(toDiscovered);
}

const workFormatOf = (v: SelVacancy): string => {
  const parts = [v.timetable_mode?.name, v.is_remote_available ? "Удаленно" : undefined].filter((s): s is string => Boolean(s));
  return parts.join(", ");
};

const descriptionOf = (v: SelVacancy): string =>
  [stripHtml(v.detailed_desc ?? ""), v.conditions && `Условия:\n${stripHtml(v.conditions)}`].filter((s): s is string => Boolean(s?.trim())).join("\n\n");

async function fetchJob(_token: string, d: Discovered) {
  const v = await getJson<SelVacancy>(`${API}/${d.externalId.replace(/^site:selectel:/, "")}`);
  return makeVacancy({
    source: "site:selectel",
    externalId: d.externalId,
    url: vacancyUrl(v.id),
    title: v.title.trim(),
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.city?.name || d.location || "",
    workFormat: workFormatOf(v),
  });
}

export const client: ATSClientImpl = {
  kind: "site:selectel",
  verified: true,
  notes:
    "no docs; public JSON API GET /proxy/public/employee/api/public/vacancies?per_page=1000&page=1&brand=selectel " +
    "on api.selectel.ru (per_page=1000 covers the real total in one page, 23 seen live); detail via " +
    "GET .../vacancies/{id} (detailed_desc HTML, conditions HTML often null); no salary ever exposed; " +
    "apply is a client-rendered form on the human vacancy page (selectel.ru/careers/all/vacancy/{id}/), " +
    "no public apply API found -> agent flow only",
  jobsUrl: () => `${API}?per_page=${PER_PAGE}&page=1&brand=selectel`,
  detect,
  listJobs,
  fetchJob,
};
