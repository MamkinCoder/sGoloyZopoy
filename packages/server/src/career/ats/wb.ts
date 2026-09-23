// Wildberries/RWB careers site (career.wb.ru -> redirects to career.rwb.ru), a React SPA.
// No public docs; endpoints found by fetching the SPA's JS bundle 2026-09 and confirmed live:
//   GET https://career.rwb.ru/hr-crm-api/api/v2/pub/vacancies?limit=&offset=&title=  -> list, paginated
//   GET https://career.rwb.ru/crm-api/api/v1/pub/vacancies/{id}                      -> detail
// Single tenant (no board token), so `token` is unused by list/fetch and only carries detect() intent.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf } from "../http.js";
import { makeVacancy } from "../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "./types.js";

const ORIGIN = "https://career.rwb.ru";
const LIST_API = `${ORIGIN}/hr-crm-api/api/v2/pub/vacancies`;
const DETAIL_API = `${ORIGIN}/crm-api/api/v1/pub/vacancies`;
const PAGE_SIZE = 100;

export interface WBListItem {
  id: number;
  name: string;
  city_title?: string;
  direction_title?: string;
  direction_role_title?: string;
  experience_type_title?: string;
  employment_types?: { id: number; title: string }[];
}

export interface WBVacancy {
  id: number;
  name: string;
  description?: string;
  requirements_arr?: string[];
  duties_arr?: string[];
  conditions_arr?: string[];
  direction_name?: string;
  office_location_city_title?: string;
  experience_type_title?: string;
  employment_types_list?: { id: number; title: string }[];
  salary_from?: number | null;
}

function detect(baseUrl: string): { token: string } | null {
  const host = hostOf(baseUrl);
  return /(^|\.)wb\.ru$/.test(host) || /(^|\.)rwb\.ru$/.test(host) ? { token: host } : null;
}

const toDiscovered = (v: WBListItem): Discovered => ({
  externalId: atsId("wb", v.id),
  url: `${ORIGIN}/vacancies/${v.id}`,
  title: v.name,
  company: "Wildberries",
  location: v.city_title || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let offset = 0;
  for (;;) {
    const page = await getJson<{ data: { items: WBListItem[]; range: { count: number } } }>(
      `${LIST_API}?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    const items = page.data?.items ?? [];
    out.push(...items.map(toDiscovered));
    offset += items.length;
    if (items.length === 0 || offset >= (page.data?.range?.count ?? 0)) break;
  }
  return out;
}

const workFormatOf = (v: WBVacancy): string => v.employment_types_list?.map((t) => t.title).join(", ") ?? "";

function descriptionOf(v: WBVacancy): string {
  const section = (title: string, items?: string[]) =>
    items?.length ? `${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";
  return [v.description ?? "", section("Требования", v.requirements_arr), section("Обязанности", v.duties_arr), section("Условия", v.conditions_arr)]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const res = await getJson<{ data: WBVacancy }>(`${DETAIL_API}/${rawId(d.externalId)}`);
  const v = res.data;
  return makeVacancy({
    source: "wb",
    externalId: d.externalId,
    url: d.url,
    title: v.name ?? d.title,
    company: "Wildberries",
    descriptionText: descriptionOf(v),
    area: v.office_location_city_title || d.location || "",
    workFormat: workFormatOf(v),
    salaryFrom: v.salary_from ?? 0,
  });
}

export const wb: ATSClientImpl = {
  kind: "wb",
  verified: true,
  notes:
    "single-tenant career site (React SPA), list/detail JSON public and unauthenticated; " +
    "IT-relevant direction_ids (from GET /hr-crm-api/api/v2/pub/directions): 3 Разработка, 4 Тестирование, " +
    "5 Базы данных, 6 Инфраструктура, 7 Data science, 8 Информационная безопасность (listJobs returns all, unfiltered); " +
    "apply is POST /crm-api/api/v1/pub/response (multipart: data=JSON, resume_file, optional portfolio_file), " +
    "no login, but gated by a one-time-token challenge from POST /api/v1/create-one-time-token (likely anti-bot/captcha) -> agent flow handles apply",
  jobsUrl: () => `${LIST_API}?limit=${PAGE_SIZE}&offset=0`,
  detect,
  listJobs,
  fetchJob,
};
