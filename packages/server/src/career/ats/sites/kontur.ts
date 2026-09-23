// Kontur careers site (kontur.ru/career/vacancies), a server-rendered ASP.NET Core page (no SPA
// bundle, no XHR API). The whole list - every rubric/category - is inline in one plain GET, no
// pagination and no query params needed (the "Фильтры" UI just toggles visibility client-side over
// the same DOM). Verified live 2026-09 (~90 vacancies across ~22 rubrics).
//   GET /career/vacancies      -> HTML; each job is <a class="vacancy" href="/career/vacancies/{id}">
//                                  with a <span class="vacancy__title">.
//   GET /career/vacancies/{id} -> HTML; full text + locations + employment type live in a clean
//                                  schema.org JobPosting JSON-LD block (<script type="application/
//                                  ld+json">{"@type":"JobPosting",...}). description is plain text
//                                  (a few &nbsp; entities, no markup). No baseSalary field ever seen.
// Apply is a classic HTML POST form (#ResumeForm: ФИО/Телефон/email + honeypot field + resume file
// upload), no public apply API -> agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://kontur.ru";
const LIST_URL = `${ORIGIN}/career/vacancies`;
const COMPANY = "Контур";

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "kontur.ru" && /\/career\/vacancies/.test(new URL(baseUrl).pathname)) return { token: ORIGIN };
  return /kontur\.ru\/career\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

// Each job is <a class="vacancy" href="/career/vacancies/{id}">...<span class="vacancy__title">
// {title}</span>...</a>; the title span is the only thing we need out of the anchor (the rest of
// the anchor body is a location/work-format summary div, not part of the title).
const VACANCY_ANCHOR_RE =
  /<a class="vacancy" href="\/career\/vacancies\/(\d+)"[^>]*>\s*<span[^>]*class="vacancy__title">([\s\S]*?)<\/span>/g;

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(LIST_URL);
  const seen = new Set<string>();
  const out: Discovered[] = [];
  for (const m of html.matchAll(VACANCY_ANCHOR_RE)) {
    const id = m[1] as string;
    const title = stripHtml(m[2] ?? "");
    if (!title || seen.has(id)) continue;
    seen.add(id);
    out.push({
      externalId: atsId("site:kontur", id),
      url: `${ORIGIN}/career/vacancies/${id}`,
      title,
      company: COMPANY,
      raw: undefined,
    });
  }
  return out;
}

interface JobPostingLD {
  title?: string;
  description?: string;
  employmentType?: string;
  jobLocationType?: string;
  jobLocation?: { address?: { addressLocality?: string } } | { address?: { addressLocality?: string } }[];
}

const LD_JSON_RE = /<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"JobPosting".*?)<\/script>/;

function jobPostingOf(html: string): JobPostingLD | null {
  const m = LD_JSON_RE.exec(html);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as JobPostingLD;
  } catch {
    return null;
  }
}

function areaOf(d: JobPostingLD): string {
  const cities = [d.jobLocation ?? []].flat().map((l) => l.address?.addressLocality).filter((c): c is string => Boolean(c));
  return [...new Set(cities)].join(", ");
}

function workFormatOf(d: JobPostingLD): string {
  return d.jobLocationType === "TELECOMMUTE" ? "офис, удалённо или гибридно" : "";
}

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const posting = jobPostingOf(html);
  return makeVacancy({
    source: "site:kontur",
    externalId: d.externalId,
    url: d.url,
    title: posting?.title ? decodeEntities(posting.title) : d.title,
    company: COMPANY,
    descriptionText: posting?.description ? decodeEntities(posting.description) : "",
    area: posting ? areaOf(posting) : "",
    workFormat: posting ? workFormatOf(posting) : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:kontur",
  verified: true,
  notes:
    "no public JSON API; list is the full server-rendered GET /career/vacancies HTML (all rubrics, no " +
    "pagination); detail description/locations/employmentType come from a schema.org JobPosting JSON-LD " +
    "block on GET /career/vacancies/{id}, plain-text description, no baseSalary ever exposed; apply is a " +
    "classic HTML POST form (#ResumeForm: ФИО/телефон/email + honeypot field + resume upload), no public " +
    "apply API found -> agent flow only",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
