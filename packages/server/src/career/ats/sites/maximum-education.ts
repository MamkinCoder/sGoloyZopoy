// MAXIMUM Education careers site. maximumtest.ru/career redirects to career.maximumacademy.ru, a
// dev-mode Vite React SPA (raw /src/*.tsx served, no bundling) whose pages call a same-origin JSON
// API read from src/lib/recruit-api.ts. Verified live 2026-09.
//   GET /api/v1/vacancy-sections     -> all open vacancies grouped by department, one call, no
//                                        pagination (small company: ~15 total across all sections)
//   GET /api/v1/vacancies/{slug}     -> full detail, same shape plus nothing extra beyond the list item
// Both wrap the payload as {"data": ...}. No IT vacancies open as of writing; listJobs still returns
// every section unfiltered per the standard contract (runner filters by keyword later).
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://career.maximumacademy.ru";
const API = `${ORIGIN}/api/v1`;
const COMPANY = "Maximum Education";

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:maximum-education" is
// itself two colon-segments, so peel our own known prefix instead (same as sites/beeline.ts).
const KIND_PREFIX = "site:maximum-education:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

export interface MaxEduVacancy {
  id: number;
  slug: string;
  title: string;
  department?: string;
  location?: string;
  type?: string;
  tags?: string[];
  salary?: string;
  description?: string;
  tasks?: string[];
  requirements?: string[];
  conditions?: string[];
}

interface MaxEduSection {
  id: number;
  slug: string;
  name: string;
  sortOrder: number;
  vacancies: MaxEduVacancy[];
}

interface ApiEnvelope<T> {
  data: T;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "career.maximumacademy.ru") return { token: ORIGIN };
  return /career\.maximumacademy\.ru\/api\/v1\/vacanc/.test(html) ? { token: ORIGIN } : null;
}

const toDiscovered = (v: MaxEduVacancy): Discovered => ({
  externalId: atsId("site:maximum-education", v.slug),
  url: `${ORIGIN}/vacancies/${v.slug}`,
  title: v.title,
  company: COMPANY,
  location: v.location || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const res = await getJson<ApiEnvelope<MaxEduSection[]>>(`${API}/vacancy-sections`);
  const out: Discovered[] = [];
  for (const section of res.data) out.push(...(section.vacancies ?? []).map(toDiscovered));
  return out;
}

// "от 70 000" | "130 000 - 160 000" | "" (unset)
function parseSalary(text: string | undefined): { salaryFrom: number; salaryTo: number; currency: string } {
  const nums = [...(text ?? "").matchAll(/[\d\s]{2,}/g)].map((m) => Number(m[0].replace(/\s/g, ""))).filter((n) => n > 0);
  if (nums.length === 0) return { salaryFrom: 0, salaryTo: 0, currency: "" };
  return { salaryFrom: nums[0] ?? 0, salaryTo: nums.length > 1 ? (nums[1] ?? 0) : 0, currency: "RUR" };
}

function descriptionOf(v: MaxEduVacancy): string {
  const section = (title: string, items?: string[]) =>
    items?.length ? `${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";
  return [v.description ?? "", section("Задачи", v.tasks), section("Требования", v.requirements), section("Условия", v.conditions)]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const res = await getJson<ApiEnvelope<MaxEduVacancy>>(`${API}/vacancies/${localId(d.externalId)}`);
  const v = res.data;
  const { salaryFrom, salaryTo, currency } = parseSalary(v.salary);
  return makeVacancy({
    source: "site:maximum-education",
    externalId: d.externalId,
    url: d.url,
    title: v.title || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.location || d.location || "",
    workFormat: v.type ?? "",
    salaryFrom,
    salaryTo,
    currency,
  });
}

export const client: ATSClientImpl = {
  kind: "site:maximum-education",
  verified: true,
  notes:
    "no public docs; site is a dev-mode Vite SPA serving raw source (src/lib/recruit-api.ts) that calls " +
    "its own public JSON API at /api/v1/vacancy-sections (list, all sections/vacancies in one call, " +
    "no pagination) and /api/v1/vacancies/{slug} (detail); both wrap payload as {data: ...}; salary is " +
    "a free-text string ('от N' or a range), parsed with a regex, RUB assumed; apply is POST " +
    "/api/v1/vacancies/{slug}/applications (multipart FormData, no auth/captcha seen in source but " +
    "untested live) -> agent flow only, no apply()",
  jobsUrl: () => `${API}/vacancy-sections`,
  detect,
  listJobs,
  fetchJob,
};
