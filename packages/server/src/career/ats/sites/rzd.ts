// RZD careers site (team.rzd.ru), a Rails app whose vacancy list/detail pages are a Vue island
// (<pages-career-vacancies />) that fetches a public JSON API. Endpoints found by reading the eager
// Vue bundle (/vite/assets/register-vue-components.eager-*.js) and confirmed live 2026-09:
//   GET /api/v1/career/vacancies?page=&per_page=   -> paginated list ({data, meta: {pages, count,...}})
//   GET /api/v1/career/vacancies/{id}               -> full detail (camelCase; HTML-ish text fields)
// Canonical vacancy URL is /career/vacancies/{id}. ~6800 open vacancies across all of RZD as of
// 2026-09 (railway operations, not just tech); listJobs returns everything unfiltered per contract,
// the runner keyword-filters afterwards. direction_id=4 ("Информационные технологии и инновации")
// exists as a list filter but is not applied here for the same reason.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://team.rzd.ru";
const LIST_API = `${ORIGIN}/api/v1/career/vacancies`;
const PAGE_SIZE = 100;
const COMPANY = "РЖД";

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:rzd" is itself two
// colon-segments, so peel our own known prefix instead (same issue as sites/rostelecom.ts).
const KIND_PREFIX = "site:rzd:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

const WORK_FORMATS: Record<string, string> = {
  fully: "Полный день",
  shift: "Сменный график",
  flexible: "Гибкий график",
  remote: "Удаленная работа",
  watchy: "Вахтовый метод",
};

export interface RZDListItem {
  id: number;
  position_title: string;
  locality_name?: string | null;
  salary_from?: number | null;
  salary_to?: number | null;
  published_at?: string | null;
}

interface RZDListResponse {
  data: RZDListItem[];
  meta: { count: number; page: number; pages: number };
}

export interface RZDVacancy {
  id: number;
  positionTitle: string;
  localityName?: string | null;
  schedule?: string | null;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  requirements?: string | null;
  responsibilities?: string | null;
  conditions?: string | null;
  package?: string | null;
  description?: string | null;
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "team.rzd.ru" ? { token: ORIGIN } : null;
}

const vacancyUrl = (id: number | string): string => `${ORIGIN}/career/vacancies/${id}`;

const toDiscovered = (v: RZDListItem): Discovered => ({
  externalId: atsId("site:rzd", v.id),
  url: vacancyUrl(v.id),
  title: v.position_title,
  company: COMPANY,
  location: v.locality_name || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let page = 1; ; page++) {
    const data = await getJson<RZDListResponse>(`${LIST_API}?page=${page}&per_page=${PAGE_SIZE}`);
    const items = data.data ?? [];
    out.push(...items.map(toDiscovered));
    if (items.length === 0 || page >= (data.meta?.pages ?? 0)) break;
  }
  return out;
}

function descriptionOf(v: RZDVacancy): string {
  const section = (title: string, html?: string | null) => {
    const text = stripHtml(html ?? "");
    return text ? `${title}:\n${text}` : "";
  };
  return [
    section("Обязанности", v.responsibilities),
    section("Требования", v.requirements),
    section("Условия", v.conditions),
    section("Что мы предлагаем", v.package),
    section("Описание", v.description),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const v = await getJson<RZDVacancy>(`${LIST_API}/${localId(d.externalId)}`);
  return makeVacancy({
    source: "site:rzd",
    externalId: d.externalId,
    url: d.url,
    title: v.positionTitle ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.localityName || d.location || "",
    workFormat: (v.schedule && WORK_FORMATS[v.schedule]) || "",
    salaryFrom: v.salaryFrom ?? 0,
    salaryTo: v.salaryTo ?? 0,
    currency: v.salaryFrom || v.salaryTo ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:rzd",
  verified: true,
  notes:
    "public JSON API, no auth: GET /api/v1/career/vacancies?page=&per_page= (1-indexed page, ~6800 open " +
    "vacancies across all of RZD as of 2026-09, listJobs returns all unfiltered - most are railway ops " +
    "roles, not software; runner keyword-filters); GET /api/v1/career/vacancies/{id} for full detail " +
    "(camelCase, requirements/responsibilities/conditions/package as HTML). direction_id=4 filters to " +
    "an 'IT' direction list-side but is not used here (small, mixed non-dev roles; contract wants all " +
    "jobs returned). No remote-format field beyond schedule (fully/shift/flexible/remote/watchy). " +
    "Apply is POST /api/v1/career/vacancies/apply, a client-rendered form (name, phone, email, resume) " +
    "on the vacancy page - not inspected past that point -> agent flow only, no apply() implemented.",
  jobsUrl: () => `${LIST_API}?page=1&per_page=${PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
