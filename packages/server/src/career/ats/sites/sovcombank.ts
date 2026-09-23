// Sovcombank careers site (people.sovcombank.ru), a Nuxt SPA. No docs; endpoints found by reading
// the SPA's JS bundles (the route chunk for /vacancies/[id] imports an api module calling these).
// Public JSON API, no auth, verified live 2026-09 (668 open vacancies across the whole group):
//   GET /api/v1/vacancies?page=<n>  -> Laravel-style pagination {data:[...], meta:{current_page,
//                                      last_page,...}}; fixed per_page=50, no override param found.
//   GET /api/v1/vacancies/{id}/show -> {data:{...}} full posting: requirements/conditions/
//                                      responsibilities are sanitized HTML fragments, cities[],
//                                      employment[] (schedule), company.name (group company, e.g.
//                                      "Совкомбанк Технологии" for IT roles, not always "Совкомбанк").
// No pagination/filter by category found beyond page; listJobs returns everything unfiltered (the
// runner filters by keyword later). Apply is a client-rendered multi-step form posting through
// Ge.sendVacancyForm (name/phone/email/city/resume + smart-token from Yandex SmartCaptcha) -> no
// public apply API, agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://people.sovcombank.ru";
const LIST_API = `${ORIGIN}/api/v1/vacancies`;
const COMPANY = "Sovcombank";

interface SCLabel {
  id: number;
  name: string;
}

interface SCVacancyListItem {
  id: number;
  title: string;
  salary_min?: number | null;
  salary_max?: number | null;
  cities?: SCLabel[];
  company?: SCLabel;
  slug: string;
}

interface SCVacancyDetail extends SCVacancyListItem {
  requirements?: string | null;
  conditions?: string | null;
  responsibilities?: string | null;
  place_job?: string | null;
  employment?: SCLabel[];
}

interface SCListResponse {
  data: SCVacancyListItem[];
  meta: { current_page: number; last_page: number };
}

interface SCDetailResponse {
  data: SCVacancyDetail;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "people.sovcombank.ru") return { token: ORIGIN };
  return /people\.sovcombank\.ru\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (id: number | string): string => `${ORIGIN}/vacancies/${id}`;

const cityOf = (v: SCVacancyListItem): string => v.cities?.[0]?.name ?? "";

const toDiscovered = (v: SCVacancyListItem): Discovered => ({
  externalId: atsId("site:sovcombank", v.id),
  url: vacancyUrl(v.id),
  title: v.title,
  company: v.company?.name || COMPANY,
  location: cityOf(v) || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let page = 1; ; page++) {
    const res = await getJson<SCListResponse>(`${LIST_API}?page=${page}`);
    out.push(...res.data.map(toDiscovered));
    if (page >= res.meta.last_page || res.data.length === 0) break;
  }
  return out;
}

function descriptionOf(v: SCVacancyDetail): string {
  const section = (title: string, html?: string | null) => {
    const text = stripHtml(decodeEntities(html ?? ""));
    return text ? `${title}:\n${text}` : "";
  };
  return [section("Обязанности", v.responsibilities), section("Требования", v.requirements), section("Условия", v.conditions)]
    .filter(Boolean)
    .join("\n\n");
}

const workFormatOf = (v: SCVacancyDetail): string => v.employment?.map((e) => e.name).join(", ") ?? "";

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const res = await getJson<SCDetailResponse>(`${LIST_API}/${rawId(d.externalId)}/show`);
  const v = res.data;
  return makeVacancy({
    source: "site:sovcombank",
    externalId: d.externalId,
    url: d.url,
    title: v.title ?? d.title,
    company: v.company?.name || d.company,
    descriptionText: descriptionOf(v),
    area: cityOf(v) || d.location || "",
    workFormat: workFormatOf(v),
    salaryFrom: v.salary_min ?? 0,
    salaryTo: v.salary_max ?? 0,
    currency: v.salary_min || v.salary_max ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:sovcombank",
  verified: true,
  notes:
    "public JSON API, no auth: GET /api/v1/vacancies?page= (Laravel pagination, fixed per_page=50, " +
    "668 open vacancies as of 2026-09, listJobs returns all unfiltered, no category/keyword filter param " +
    "found); detail via GET /api/v1/vacancies/{id}/show (requirements/conditions/responsibilities are " +
    "sanitized HTML, stripped here; company can be a group subsidiary e.g. 'Совкомбанк Технологии' for " +
    "IT roles, not always the parent 'Совкомбанк'); salary_min/salary_max are plain RUB numbers when set, " +
    "usually null; apply is a client-rendered multi-step form gated by Yandex SmartCaptcha " +
    "(Ge.sendVacancyForm, smart-token) -> no public apply API, agent flow only",
  jobsUrl: () => `${LIST_API}?page=1`,
  detect,
  listJobs,
  fetchJob,
};
