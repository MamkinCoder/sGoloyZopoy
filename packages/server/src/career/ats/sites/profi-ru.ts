// Profi.ru careers site. `career.profi.ru` (the nominal base_url) does not resolve; the real
// listing lives on the main site at profi.ru/vacancies/list/, a Next.js page. There is no XHR/JSON
// API: everything (category list with each job's id/folder/short text, and per-job full text) is
// server-rendered into the page's __NEXT_DATA__ blob. Verified live 2026-09: 5 open jobs across
// 11 categories. Detail pages carry no salary/area/employment-type fields, only rich-text blocks
// (fullText intro + titled descriptionBlocks); concatenated and stripped to plain text here.
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://profi.ru";
const LIST_URL = `${ORIGIN}/vacancies/list/`;
const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

function readNextData<T>(html: string): T | null {
  const m = NEXT_DATA_RE.exec(html);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
}

interface ProfiListItem {
  id: number;
  name: string;
  shortText?: string | null;
  folder: string;
  category?: { name?: string };
}

interface ProfiCategory {
  id: number;
  name: string;
  banners: ProfiListItem[];
  vacancies: ProfiListItem[];
}

interface ProfiListPageProps {
  categories: ProfiCategory[];
}

interface ProfiDescriptionBlock {
  title?: string;
  description?: string;
}

interface ProfiVacancyDetails {
  id: number;
  name: string;
  fullText?: string;
  descriptionBlocks?: ProfiDescriptionBlock[];
}

interface ProfiVacancyPageProps {
  vacancyDetails: ProfiVacancyDetails;
}

const vacancyUrl = (folder: string): string => `${ORIGIN}/vacancies/${folder}/`;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "profi.ru" && /\/vacanc/i.test(new URL(baseUrl).pathname)) return { token: ORIGIN };
  return /profi\.ru\/vacancies\//i.test(html) ? { token: ORIGIN } : null;
}

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(LIST_URL);
  const data = readNextData<{ props: { pageProps: ProfiListPageProps } }>(html);
  const categories = data?.props.pageProps.categories ?? [];
  const out: Discovered[] = [];
  for (const cat of categories) {
    for (const v of [...cat.banners, ...cat.vacancies]) {
      out.push({
        externalId: atsId("site:profi-ru", v.id),
        url: vacancyUrl(v.folder),
        title: v.name,
        company: "Profi.ru",
        raw: v,
      });
    }
  }
  return out;
}

function descriptionOf(vd: ProfiVacancyDetails): string {
  const blocks = (vd.descriptionBlocks ?? [])
    .map((b) => [b.title, stripHtml(b.description ?? "")].filter(Boolean).join("\n"))
    .filter(Boolean);
  return [stripHtml(vd.fullText ?? ""), ...blocks].filter(Boolean).join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const data = readNextData<{ props: { pageProps: ProfiVacancyPageProps } }>(html);
  const vd = data?.props.pageProps.vacancyDetails;
  return makeVacancy({
    source: "site:profi-ru",
    externalId: d.externalId,
    url: d.url,
    title: vd?.name ?? d.title,
    company: "Profi.ru",
    descriptionText: vd ? descriptionOf(vd) : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:profi-ru",
  verified: true,
  notes:
    "career.profi.ru does not resolve; real listing is profi.ru/vacancies/list/ (Next.js, server-rendered). " +
    "No JSON API: list and detail are read from each page's __NEXT_DATA__ blob. " +
    "5 open jobs across 11 categories as of 2026-09; detail has no salary/area/employment-type, only rich-text blocks. " +
    "Apply is not a form: each job page just names an HR contact to message directly → no apply API, agent/human flow only.",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
