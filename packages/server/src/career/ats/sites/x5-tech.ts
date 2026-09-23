// X5 Tech careers site (x5.tech/vacancy), a Next.js app whose vacancy list/detail is fetched
// client-side from a public JSON API on a separate host, found by reading the vacancy page's JS
// chunks for the auto-generated API client (baseUrl "https://prod-lkk-back.x5.ru"):
//   GET /api/v2/x5-tech/vacancies/?page=&page_size=  -> paginated list, page_size up to 50 covers
//                                                        all jobs in one request (25 open 2026-09)
//   GET /api/v2/x5-tech/vacancies/{id}/              -> detail (same shape as a list item)
// List items already carry the full description (data.main_responsibilities/professional_skills/
// working_conditions, markdown-ish bullets) and salary_min/salary_max (never populated so far), so
// fetchJob just re-fetches by id for freshness rather than trusting cached list data. No pagination
// needed in practice but listJobs still follows next_page defensively. Verified live 2026-09 (25
// open vacancies, all software/data/IT roles - X5 Tech has no non-tech postings).
// Apply is POST /api/v2/x5-tech/candidates/ (resume fields, JSON) - not inspected further, no login
// visible in the API client, but left to the agent flow since the exact payload wasn't confirmed.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://x5.tech";
const API = "https://prod-lkk-back.x5.ru/api/v2/x5-tech/vacancies/";
const COMPANY = "X5 Tech";
const PAGE_SIZE = 50;

interface X5VacancyData {
  main_responsibilities?: string | null;
  professional_skills?: string | null;
  personal_qualities?: string | null;
  working_conditions?: string | null;
  software_skills?: string | null;
  education?: string | null;
  salary?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
}

interface X5VacancyItem {
  id: string;
  name: string;
  city?: string | null;
  work_format?: string | null; // "office" | "remote" | "hybrid"
  data: X5VacancyData;
}

interface X5ListResponse {
  total_count: number;
  next_page: number | null;
  items: X5VacancyItem[];
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "x5.tech" ? { token: ORIGIN } : null;
}

const WORK_FORMAT_RU: Record<string, string> = { office: "Офис", remote: "Удаленно", hybrid: "Гибрид" };
const workFormatOf = (v: X5VacancyItem): string => (v.work_format && WORK_FORMAT_RU[v.work_format]) || v.work_format || "";

const vacancyUrl = (id: string): string => `${ORIGIN}/vacancy/${id}`;

const toDiscovered = (v: X5VacancyItem): Discovered => ({
  externalId: atsId("site:x5-tech", v.id),
  url: vacancyUrl(v.id),
  title: v.name,
  company: COMPANY,
  location: v.city || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let page = 1;
  for (;;) {
    const res = await getJson<X5ListResponse>(`${API}?page=${page}&page_size=${PAGE_SIZE}`);
    out.push(...res.items.map(toDiscovered));
    if (!res.next_page || res.items.length === 0) break;
    page = res.next_page;
  }
  return out;
}

function descriptionOf(d: X5VacancyData): string {
  const section = (title: string, body?: string | null) => (body?.trim() ? `${title}\n${body.trim()}` : "");
  return [
    section("Обязанности", d.main_responsibilities),
    section("Требования", d.professional_skills),
    section("Будет плюсом", d.software_skills),
    section("Личные качества", d.personal_qualities),
    section("Условия", d.working_conditions),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const v = await getJson<X5VacancyItem>(`${API}${rawId(d.externalId)}/`);
  return makeVacancy({
    source: "site:x5-tech",
    externalId: d.externalId,
    url: d.url,
    title: v.name ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v.data ?? {}),
    area: v.city || d.location || "",
    workFormat: workFormatOf(v),
    salaryFrom: v.data?.salary_min ?? 0,
    salaryTo: v.data?.salary_max ?? 0,
  });
}

export const client: ATSClientImpl = {
  kind: "site:x5-tech",
  verified: true,
  notes:
    "public JSON API on a separate host found in the vacancy page's JS bundle (auto-generated API " +
    "client, baseUrl https://prod-lkk-back.x5.ru), no auth: GET /api/v2/x5-tech/vacancies/?page&page_size " +
    "(list, page_size=50 covers all 25 open jobs in one request) and GET " +
    "/api/v2/x5-tech/vacancies/{id}/ (detail, same shape). List items already carry the full " +
    "description text; salary_min/salary_max exist in the schema but were null on every job seen. " +
    "All open roles are software/data/IT (X5 Tech posts no non-tech vacancies). Apply is POST " +
    "/api/v2/x5-tech/candidates/ (JSON body, fields not inspected) -> agent flow only.",
  jobsUrl: () => `${API}?page=1&page_size=${PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
