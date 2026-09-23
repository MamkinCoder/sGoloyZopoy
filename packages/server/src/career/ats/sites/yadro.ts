// YADRO careers site (careers.yadro.com), a Next.js app whose vacancy list is client-fetched from a
// public DRF-style JSON API (not present in SSR __NEXT_DATA__, which ships an empty fallback).
// Verified live 2026-09 (205 open vacancies).
//   GET /api/v1/vacancies/?limit=300&offset=0
//     -> JSON {count, next, previous, results:[{id, slug, title, description (HTML), direction{name},
//        specialization{name}, team{name}, empl:[{name}], location:[{name}] (mixes countries+cities),
//        country:[{name}], city:[{name}] (clean city list), skill:[{name}], grade:[{name}], updated_at}]}.
//        limit=300 comfortably covers the real total in one request (default page size is 10).
//   GET /api/v1/vacancies/?id={id}  -> same shape filtered to one result (count:1); used for a fresh
//        fetchJob instead of trusting the cached list item. (?slug= is accepted but ignored - not usable.)
// Human page is https://careers.yadro.com/vacancy/{slug} (slug is the numeric id string with a "10"
// prefix, e.g. id 2517 -> slug "102517"; not derivable by formula, always read from the API). No salary
// field anywhere. Apply is a client-rendered form on that page - no public apply API found, so apply()
// is omitted; agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://careers.yadro.com";
const API = `${ORIGIN}/api/v1/vacancies/`;
const COMPANY = "YADRO";
const LIST_LIMIT = 300;

interface YLabel {
  id: number;
  name: string;
}

interface YVacancy {
  id: number;
  slug: string;
  title: string;
  description?: string;
  empl?: YLabel[];
  city?: YLabel[];
}

interface YListResponse {
  count: number;
  results: YVacancy[];
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "careers.yadro.com") return { token: ORIGIN };
  return /careers\.yadro\.com\/vacancy\//i.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (slug: string): string => `${ORIGIN}/vacancy/${slug}`;
const cityOf = (v: YVacancy): string => v.city?.map((c) => c.name).join(", ") ?? "";
const workFormatOf = (v: YVacancy): string => v.empl?.map((e) => e.name).join(", ") ?? "";

const toDiscovered = (v: YVacancy): Discovered => ({
  externalId: atsId("site:yadro", v.id),
  url: vacancyUrl(v.slug),
  title: v.title.trim(),
  company: COMPANY,
  location: cityOf(v) || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const data = await getJson<YListResponse>(`${API}?limit=${LIST_LIMIT}&offset=0`);
  return data.results.map(toDiscovered);
}

async function fetchJob(_token: string, d: Discovered) {
  const id = d.externalId.replace(/^site:yadro:/, "");
  const data = await getJson<YListResponse>(`${API}?id=${id}`);
  const v = data.results[0] ?? (d.raw as YVacancy | undefined);
  if (!v) throw new Error(`yadro: vacancy ${id} not found`);
  return makeVacancy({
    source: "site:yadro",
    externalId: d.externalId,
    url: vacancyUrl(v.slug),
    title: v.title.trim(),
    company: COMPANY,
    descriptionText: stripHtml(decodeEntities(v.description ?? "")),
    area: cityOf(v) || d.location || "",
    workFormat: workFormatOf(v),
  });
}

export const client: ATSClientImpl = {
  kind: "site:yadro",
  verified: true,
  notes:
    "no docs; public JSON API GET /api/v1/vacancies/?limit=300&offset=0 (limit=300 covers the real total " +
    "in one page, 205 seen live; default page size is 10); list items already carry full description HTML, " +
    "direction/specialization/team/empl/city/skill/grade; fetchJob re-fetches GET /api/v1/vacancies/?id={id} " +
    "for freshness; no salary field anywhere; apply is a client-rendered form on the human vacancy page " +
    "(careers.yadro.com/vacancy/{slug}), no public apply API found -> agent flow only",
  jobsUrl: () => `${API}?limit=${LIST_LIMIT}&offset=0`,
  detect,
  listJobs,
  fetchJob,
};
