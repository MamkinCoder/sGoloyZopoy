// Rostelecom careers site (job.rt.ru), a Next.js SPA. The homepage is static; the real listing is
// fetched client-side from a public JSON API found in the SPA's page bundle (chunks/pages/index-*.js,
// verified live 2026-09):
//   GET /backend/api/vacancies?page=&size=     -> paginated list, 0-indexed page, list items already
//                                                  carry the full text fields (whatWeToDo/whatWeOffer/
//                                                  whatWeExpect as HTML), so fetchJob needs no extra
//                                                  request when listJobs's Discovered.raw is available.
//   GET /backend/api/vacancies/{id}            -> same shape, single vacancy (fallback).
// Canonical vacancy URL is /vacancy/{id} (route "/vacancy/[vacancyId]" in the bundle). No employment/
// remote-format field is ever present in the payload. ~411 open vacancies as of 2026-09.
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.rt.ru";
const LIST_API = `${ORIGIN}/backend/api/vacancies`;
const PAGE_SIZE = 100;
const COMPANY = "Rostelecom";

export interface RTVacancy {
  id: number;
  name: string;
  address?: string | null;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  salaryCurrency?: string | null;
  city?: { id: number; name: string } | null;
  whatWeToDo?: string;
  whatWeOffer?: string;
  whatWeExpect?: string;
}

interface RTListResponse {
  totalPages: number;
  totalCount: number;
  vacancies: RTVacancy[];
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "job.rt.ru" ? { token: ORIGIN } : null;
}

const vacancyUrl = (id: number | string): string => `${ORIGIN}/vacancy/${id}`;

const toDiscovered = (v: RTVacancy): Discovered => ({
  externalId: atsId("site:rostelecom", v.id),
  url: vacancyUrl(v.id),
  title: v.name,
  company: COMPANY,
  location: v.city?.name || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let page = 0; ; page++) {
    const data = await getJson<RTListResponse>(`${LIST_API}?page=${page}&size=${PAGE_SIZE}`);
    const items = data.vacancies ?? [];
    out.push(...items.map(toDiscovered));
    if (items.length === 0 || out.length >= (data.totalCount ?? 0)) break;
  }
  return out;
}

function descriptionOf(v: RTVacancy): string {
  const section = (title: string, html?: string) => {
    const text = stripHtml(html ?? "");
    return text ? `${title}:\n${text}` : "";
  };
  return [section("Обязанности", v.whatWeToDo), section("Требования", v.whatWeExpect), section("Условия", v.whatWeOffer)]
    .filter(Boolean)
    .join("\n\n");
}

// listJobs's Discovered.raw already carries the full vacancy (list and detail share the same
// shape), so fetchJob only re-fetches by id when that cache is missing.
async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as RTVacancy | undefined;
  const v = cached ?? (await getJson<RTVacancy>(`${LIST_API}/${rawId(d.externalId)}`));
  return makeVacancy({
    source: "site:rostelecom",
    externalId: d.externalId,
    url: d.url,
    title: v.name ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.city?.name || d.location || "",
    salaryFrom: v.salaryFrom ?? 0,
    salaryTo: v.salaryTo ?? 0,
    currency: v.salaryCurrency ?? (v.salaryFrom || v.salaryTo ? "RUB" : ""),
  });
}

export const client: ATSClientImpl = {
  kind: "site:rostelecom",
  verified: true,
  notes:
    "public JSON API, no auth: GET /backend/api/vacancies?page=&size= (0-indexed page, ~411 open vacancies " +
    "across all of Rostelecom as of 2026-09, listJobs returns all unfiltered); list items already include " +
    "full text (whatWeToDo/whatWeExpect/whatWeOffer as HTML) so fetchJob reuses the cached payload from " +
    "listJobs and makes no extra request; no employment/remote-format field ever present in the payload; " +
    "apply is a client-rendered form on the vacancy page, not inspected past that point -> agent flow only, " +
    "no public apply API found",
  jobsUrl: () => `${LIST_API}?page=0&size=${PAGE_SIZE}`,
  detect,
  listJobs,
  fetchJob,
};
