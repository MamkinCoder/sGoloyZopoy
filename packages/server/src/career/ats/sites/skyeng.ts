// Skyeng careers site (job.skyeng.ru -> links to vacancies.skyeng.ru, an SSR Angular app).
// No public docs; endpoint found by reading the SSR bundle's compiled environment config
// (`endpoints.apiURL`) and confirmed live 2026-09:
//   GET https://api-employee-career-storage.skyeng.ru/api/vacancies?page=N -> {results, meta}, paginated
// The list response already embeds the full vacancy body (department_description/work_description/
// requirements/benefits as HTML) - identical shape to GET .../vacancies/{id} - so fetchJob just reuses
// the cached list item instead of a second request. No structured salary/city/format fields; that info
// (when present) is prose inside `benefits`. Public detail page is https://vacancies.skyeng.ru/{slug}.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://vacancies.skyeng.ru";
const API = "https://api-employee-career-storage.skyeng.ru/api/vacancies";
const COMPANY = "Skyeng";
const KIND = "site:skyeng";

export interface SkyengVacancy {
  id: number;
  title: string;
  slug: string;
  department_description?: string;
  work_description?: string;
  requirements?: string;
  benefits?: string;
  tags?: { title: string }[];
}

interface SkyengListPage {
  results: SkyengVacancy[];
  meta: { total: number; page_size: number; current_page: number; last_page: number };
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "vacancies.skyeng.ru" || hostOf(baseUrl) === "job.skyeng.ru") return { token: ORIGIN };
  return /vacancies\.skyeng\.ru/i.test(html) ? { token: ORIGIN } : null;
}

const toDiscovered = (v: SkyengVacancy): Discovered => ({
  externalId: atsId(KIND, v.id),
  url: `${ORIGIN}/${v.slug}`,
  title: v.title,
  company: COMPANY,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let page = 1;
  for (;;) {
    const data = await getJson<SkyengListPage>(`${API}?page=${page}`);
    out.push(...data.results.map(toDiscovered));
    if (page >= data.meta.last_page || data.results.length === 0) break;
    page++;
  }
  return out;
}

function descriptionOf(v: SkyengVacancy): string {
  const html = (s?: string) => stripHtml(decodeEntities(s ?? ""));
  const section = (title: string, body: string) => (body ? `${title}:\n${body}` : "");
  return [
    html(v.department_description),
    section("Обязанности", html(v.work_description)),
    section("Требования", html(v.requirements)),
    section("Условия", html(v.benefits)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as SkyengVacancy | undefined;
  const v = cached ?? (await getJson<SkyengVacancy>(`${API}/${rawId(d.externalId)}`));
  return makeVacancy({
    source: KIND,
    externalId: d.externalId,
    url: d.url,
    title: v.title || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    workFormat: (v.tags ?? []).map((t) => t.title).join(", "),
  });
}

export const client: ATSClientImpl = {
  kind: KIND,
  verified: true,
  notes:
    "no public docs; GET api-employee-career-storage.skyeng.ru/api/vacancies?page=N (public JSON, no auth), " +
    "confirmed live 2026-09 with 8 open roles, all sales/customer-service (no dev roles open at check time, " +
    "listJobs returns all regardless). List items already carry the full body (department_description/" +
    "work_description/requirements/benefits as HTML) - same shape as the /vacancies/{id} detail endpoint - " +
    "so fetchJob reuses the cached item and only falls back to a detail GET if raw is missing. No structured " +
    "salary/city/remote fields; that info, when given, is prose inside benefits. Public page is " +
    "vacancies.skyeng.ru/{slug} with an on-page apply button (SSR-rendered, client-side form) - no public " +
    "apply API found -> agent flow only.",
  jobsUrl: () => `${API}?page=1`,
  detect,
  listJobs,
  fetchJob,
};
