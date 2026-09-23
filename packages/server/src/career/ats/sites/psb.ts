// PSB (Промсвязьбанк) careers site (job.psbank.ru), an Angular SPA. The homepage just bootstraps
// the app; the real listing/detail data comes from a public JSON API found in the SPA's main.js
// bundle (contentApiUrl, verified live 2026-09):
//   GET /api/v1/content/vacancies?page=N  -> paginated list, 15/page, items already carry full
//     req/duty/cond text (no separate detail call needed for the description).
//   GET /api/v1/content/vacancies/{id}    -> single vacancy, same shape plus locationName/experienceName.
// Canonical vacancy URL is the SPA route /vacancies/{id}. fetchJob prefers listJobs's cached raw
// payload and only calls the detail endpoint when raw is missing (e.g. resumed from storage), since
// the detail call adds locationName which the list payload lacks (list only has a locationId).
import type { Discovered } from "@sgz/shared";
import { getJson, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.psbank.ru";
const LIST_API = `${ORIGIN}/api/v1/content/vacancies`;

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:psb" is itself two
// colon-segments, so we peel our own known prefix instead (same issue as sites/rostelecom.ts).
const KIND_PREFIX = "site:psb:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

export interface PSBVacancy {
  id: string;
  title: string;
  req?: string;
  duty?: string;
  cond?: string;
  locationId?: string;
  locationName?: string;
  workTypeName?: string;
  salary?: string;
}

interface PSBListResponse {
  data: PSBVacancy[];
  total_count: number;
  items_per_page: number;
  current_page: number;
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "job.psbank.ru" ? { token: "job.psbank.ru" } : null;
}

const vacancyUrl = (id: string): string => `${ORIGIN}/vacancies/${id}`;

const toDiscovered = (v: PSBVacancy): Discovered => ({
  externalId: atsId("site:psb", v.id),
  url: vacancyUrl(v.id),
  title: v.title,
  company: "PSB",
  location: v.locationName || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let page = 0;
  for (;;) {
    const res = await getJson<PSBListResponse>(`${LIST_API}?page=${page}`);
    out.push(...res.data.map(toDiscovered));
    if (res.data.length === 0 || out.length >= res.total_count) break;
    page++;
  }
  return out;
}

function descriptionOf(v: PSBVacancy): string {
  const section = (title: string, text?: string) => (text?.trim() ? `${title}:\n${text.trim()}` : "");
  return [section("Обязанности", v.duty), section("Требования", v.req), section("Условия", v.cond)].filter(Boolean).join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const id = localId(d.externalId);
  const cached = d.raw as PSBVacancy | undefined;
  const v = cached?.locationName !== undefined ? cached : await getJson<PSBVacancy>(`${LIST_API}/${id}`);
  const salary = Number(v.salary);
  return makeVacancy({
    source: "site:psb",
    externalId: d.externalId,
    url: d.url,
    title: v.title ?? d.title,
    company: "PSB",
    descriptionText: descriptionOf(v),
    area: v.locationName || d.location || "",
    workFormat: v.workTypeName ?? "",
    salaryFrom: Number.isFinite(salary) && salary > 0 ? salary : 0,
    currency: Number.isFinite(salary) && salary > 0 ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:psb",
  verified: true,
  notes:
    "public JSON API, no auth: GET /api/v1/content/vacancies?page=N (15/page, ~350 open vacancies " +
    "across all of PSB as of 2026-09, listJobs returns all unfiltered; ~21 are IT/dev). List items " +
    "already include full req/duty/cond text so fetchJob reuses the cached payload from listJobs and " +
    "only calls GET /api/v1/content/vacancies/{id} (adds locationName) when raw is missing. Apply is a " +
    "client-rendered form (forms/candidate) gated behind an hh.ru OAuth token exchange (hhauthconfig / " +
    "gethhtoken) -> agent flow only, no public apply API found.",
  jobsUrl: () => `${LIST_API}?page=0`,
  detect,
  listJobs,
  fetchJob,
};
