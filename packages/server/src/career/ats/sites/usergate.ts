// UserGate careers site (usergate.com/company/career), a React SPA. No docs; the API path was found
// in the app bundle (/f/dist/app.*.bundle.js): a shared axios instance with baseURL "/api/v1" backs
// vacancies.fetchAll/fetchDetail. Verified live 2026-09 (36 open vacancies, one unpaginated page).
//   POST https://usergate.com/api/v1/vacancies/all {}
//     -> {success,data:{vacancies:[{external_id,name,city,employment,experience,alternate_url}],amount}}
//   GET  https://usergate.com/api/v1/vacancies/detail/{external_id}
//     -> {success,data:{vacancy:{...same fields,description:HTML,salary_from,salary_to}}}
// external_id is the source hh.ru vacancy id (alternate_url always points to hh.ru/vacancy/{id}) but
// this is UserGate's own site/API serving its own JSON with full description - not the hh.ru pipeline.
// salary_from/salary_to observed null on every vacancy checked. No human-readable per-vacancy page was
// found on usergate.com itself (the SPA route has no server-rendered deep link), so vacancy.url points
// at the hh.ru listing, which is also where UserGate's own apply button sends candidates -> agent flow
// only, apply() omitted (no public apply API on either domain).
import type { Discovered } from "@sgz/shared";
import { getJson, postJson, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const SITE_ORIGIN = "https://usergate.com";
const API = `${SITE_ORIGIN}/api/v1/vacancies`;
const COMPANY = "UserGate";

interface UGVacancy {
  external_id: number;
  name: string;
  city?: string | null;
  employment?: string | null;
  experience?: string | null;
  alternate_url: string;
  description?: string;
  salary_from?: number | null;
  salary_to?: number | null;
}

interface UGListResponse {
  success: boolean;
  data: { vacancies: UGVacancy[]; amount: number };
}

interface UGDetailResponse {
  success: boolean;
  data: { vacancy: UGVacancy };
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (/(^|\.)usergate\.com$/.test(new URL(baseUrl).hostname.toLowerCase()) && /\/company\/career\b/.test(new URL(baseUrl).pathname)) {
    return { token: SITE_ORIGIN };
  }
  return /usergate\.com\/api\/v1\/vacancies/i.test(html) ? { token: SITE_ORIGIN } : null;
}

const toDiscovered = (v: UGVacancy): Discovered => ({
  externalId: atsId("site:usergate", v.external_id),
  url: v.alternate_url,
  title: v.name.trim(),
  company: COMPANY,
  location: v.city || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const res = await postJson<UGListResponse>(`${API}/all`, {});
  return res.data.vacancies.map(toDiscovered);
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const id = d.externalId.replace(/^site:usergate:/, "");
  const res = await getJson<UGDetailResponse>(`${API}/detail/${id}`);
  const v = res.data.vacancy;
  return makeVacancy({
    source: "site:usergate",
    externalId: d.externalId,
    url: v.alternate_url || d.url,
    title: v.name.trim(),
    company: COMPANY,
    descriptionText: stripHtml(v.description ?? ""),
    area: v.city || d.location || "",
    workFormat: v.employment || "",
    salaryFrom: v.salary_from ?? 0,
    salaryTo: v.salary_to ?? 0,
  });
}

export const client: ATSClientImpl = {
  kind: "site:usergate",
  verified: true,
  notes:
    "no docs; public JSON API POST /api/v1/vacancies/all {} on usergate.com (own SPA's axios client, " +
    "36 seen live, unpaginated) and GET /api/v1/vacancies/detail/{id} for full HTML description; " +
    "salary_from/salary_to always null in practice; external_id is the source hh.ru vacancy id and " +
    "vacancy.url/apply both point at hh.ru/vacancy/{id} (no server-rendered detail page on usergate.com " +
    "itself, no public apply API on either domain) -> agent flow only, apply() omitted",
  jobsUrl: () => `${API}/all`,
  detect,
  listJobs,
  fetchJob,
};
