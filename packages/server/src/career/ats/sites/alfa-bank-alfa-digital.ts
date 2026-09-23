// Alfa-Bank / Alfa Digital careers site (digital.alfabank.ru/vacancies), a Next.js app. No public
// JSON API: every vacancy (list + full detail) ships embedded in the server-rendered HTML as the
// standard Next.js hydration payload `<script id="__NEXT_DATA__" type="application/json">`.
// Verified live 2026-09.
//   GET /vacancies              -> HTML; __NEXT_DATA__.props.initialState.vacancies.vacanciesList.data
//                                   holds ALL open vacancies (17 on 2026-09), unpaginated.
//   GET /vacancies/{slug}       -> HTML; __NEXT_DATA__.props.initialState.vacancies.vacancyDetails[slug].data
//                                   holds the full text (description/duties/requirements/conditions as
//                                   separate fields), city, and contact person - no salary anywhere.
// Apply is a client-rendered form on the vacancy page (hookForms: true) - no public apply API found,
// so apply() is omitted; agent flow only.
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const KIND = "site:alfa-bank-alfa-digital";
const ORIGIN = "https://digital.alfabank.ru";
const LIST_URL = `${ORIGIN}/vacancies`;

interface ADListItem {
  id: string;
  name: string;
  slug: string;
  shortDescription?: string | null;
}

interface ADVacancyDetail {
  id: string;
  name: string;
  slug: string;
  city?: { name?: string } | null;
  descriptionText?: string | null;
  duties?: string | null;
  requirements?: string | null;
  conditions?: string | null;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "digital.alfabank.ru") return { token: ORIGIN };
  return /digital\.alfabank\.ru\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

// __NEXT_DATA__ is a single well-formed JSON blob; no balancing/flight-chunk parsing needed.
function nextData(html: string): Record<string, unknown> | null {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function vacanciesState(html: string): Record<string, unknown> | null {
  const data = nextData(html) as { props?: { initialState?: { vacancies?: Record<string, unknown> } } } | null;
  return data?.props?.initialState?.vacancies ?? null;
}

const toDiscovered = (v: ADListItem): Discovered => ({
  externalId: atsId(KIND, v.slug),
  url: `${ORIGIN}/vacancies/${v.slug}`,
  title: v.name,
  company: "Alfa-Bank / Alfa Digital",
  raw: v,
});

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/vacancies`);
  const state = vacanciesState(html) as { vacanciesList?: { data?: ADListItem[] } } | null;
  const items = state?.vacanciesList?.data ?? [];
  return items.filter((v) => v.name).map(toDiscovered);
}

function descriptionOf(v: ADVacancyDetail): string {
  const section = (title: string, text?: string | null) => (text?.trim() ? `${title}:\n${stripHtml(text)}` : "");
  return [
    v.descriptionText?.trim() ?? "",
    section("Обязанности", v.duties),
    section("Требования", v.requirements),
    section("Условия", v.conditions),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(_origin: string, d: Discovered) {
  const cached = d.raw as ADListItem | undefined;
  const slug = cached?.slug ?? d.url.split("/").filter(Boolean).pop() ?? "";
  const html = await getText(d.url);
  const state = vacanciesState(html) as { vacancyDetails?: Record<string, { data?: ADVacancyDetail }> } | null;
  const v = state?.vacancyDetails?.[slug]?.data;
  return makeVacancy({
    source: KIND,
    externalId: d.externalId,
    url: d.url,
    title: v?.name ?? cached?.name ?? d.title,
    company: "Alfa-Bank / Alfa Digital",
    descriptionText: v ? descriptionOf(v) : "",
    area: v?.city?.name ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: KIND,
  verified: true,
  notes:
    "no public JSON API; list and detail both ship in the standard Next.js __NEXT_DATA__ hydration " +
    "payload on GET /vacancies (all 17 open jobs, unpaginated) and GET /vacancies/{slug} (full text " +
    "as separate descriptionText/duties/requirements/conditions fields, plus city and contact person); " +
    "no salary field ever populated; apply is a client-rendered form on the vacancy page (hookForms: true), " +
    "no public apply API found -> agent flow only",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
