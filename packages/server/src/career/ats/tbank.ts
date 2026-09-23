// T-Bank careers site (verified 2026-09 by reading the pfpjobs bundle served with the page +
// live requests). No public docs; this is the same private JSON API the site's own frontend calls.
// List/detail are public POST endpoints on www.tbank.ru; applying needs login to rabota.tbank.ru
// (LKK_LOGIN_URL) → agent flow, no public apply API.
import type { Discovered } from "@sgz/shared";
import { hostOf, postJson, stripHtml } from "../http.js";
import { makeVacancy } from "../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "./types.js";

const API = "https://www.tbank.ru/pfpjobs/papi";
const CATEGORY = "tcareer_it";
const PAGE = 100;

interface TBVacancyListItem {
  title: string;
  subtitle?: string; // city, absent for the default HQ city
  category: string;
  shortDescription?: string;
  salary?: { amount?: number | null } | null;
  tags?: string[];
  urlSlug: string; // the vacancy id
  seoSlug: string;
}

interface TBGetVacanciesResponse {
  resultCode: string;
  payload: { vacancies: TBVacancyListItem[]; nextPagination: { offset: number; isFinished: boolean; totalCount: number } };
}

interface TBDescriptionSection {
  key: string;
  content: string | { description?: string; title?: string | null }[];
}

interface TBVacancyDescription {
  vacancyId: string;
  seoSlug: string;
  category: string;
  title: string;
  tags?: { text: string }[];
  salary?: { amount?: number | null } | null;
  description?: TBDescriptionSection[];
}

interface TBGetVacancyDescriptionResponse {
  resultCode: string;
  payload: TBVacancyDescription;
}

const vacancyFilters = () => ({
  generatedGraphQL: {
    type: "T_CAREER",
    status: "ACTIVE",
    userGroup: { groups: ["Control"], type: "SPECIFIC" },
    or: [{ category: CATEGORY }],
  },
});

const vacancyUrl = (city: string | undefined, seoSlug: string, urlSlug: string): string =>
  `https://www.tbank.ru/career/it/vacancy/${city ?? "saint-petersburg"}/${seoSlug}/${urlSlug}/`;

// citySlug is unknown per-listing item (only a Russian display name is given), so URLs use the
// default HQ slug; the site itself redirects to the right city page from the canonical vacancy id.
const toDiscovered = (v: TBVacancyListItem): Discovered => ({
  externalId: atsId("tbank", v.urlSlug),
  url: vacancyUrl(undefined, v.seoSlug, v.urlSlug),
  title: v.title,
  company: "T-Bank",
  location: v.subtitle,
  raw: v,
});

function detect(baseUrl: string, html: string): { token: string } | null {
  if (/(^|\.)tbank\.ru$/.test(hostOf(baseUrl)) && /\/career\b/.test(new URL(baseUrl).pathname)) return { token: "it" };
  return /tbank\.ru\/career\//i.test(html) ? { token: "it" } : null;
}

async function listJobs(_token: string): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const data = await postJson<TBGetVacanciesResponse>(`${API}/getVacancies`, { filters: vacancyFilters(), pagination: { offset }, limit: PAGE });
    const { vacancies, nextPagination } = data.payload;
    out.push(...vacancies.map(toDiscovered));
    if (nextPagination.isFinished || vacancies.length === 0) break;
    offset = nextPagination.offset;
  }
  return out;
}

const descriptionOf = (d: TBVacancyDescription): string =>
  (d.description ?? [])
    .map((s) => {
      const body = Array.isArray(s.content) ? s.content.map((c) => `- ${stripHtml(c.description ?? "")}`).join("\n") : stripHtml(s.content ?? "");
      return `${s.key}\n${body}`;
    })
    .join("\n\n");

async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as TBVacancyListItem | undefined;
  const data = await postJson<TBGetVacancyDescriptionResponse>(`${API}/getVacancyDescription`, {
    urlSlug: rawId(d.externalId),
    options: { category: CATEGORY },
  });
  const desc = data.payload;
  return makeVacancy({
    source: "tbank",
    externalId: d.externalId,
    url: d.url,
    title: desc.title ?? cached?.title ?? d.title,
    company: "T-Bank",
    descriptionText: descriptionOf(desc),
    area: cached?.subtitle ?? d.location ?? "",
    workFormat: (desc.tags ?? cached?.tags?.map((t) => ({ text: t })) ?? []).map((t) => t.text).filter((t) => /офис|удал|гибрид/i.test(t)).join(", "),
    salaryFrom: desc.salary?.amount ?? 0,
  });
}

export const tbank: ATSClientImpl = {
  kind: "tbank",
  verified: true,
  notes:
    "list (POST papi/getVacancies) and detail (POST papi/getVacancyDescription) public, no auth; " +
    "no salary in payloads observed; apply button is client-rendered and requires LKK login " +
    "(rabota.tbank.ru) — no public apply API, agent flow only",
  jobsUrl: () => `${API}/getVacancies`,
  detect,
  listJobs,
  fetchJob,
};
