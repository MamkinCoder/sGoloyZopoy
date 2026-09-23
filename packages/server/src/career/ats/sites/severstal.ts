// Severstal careers site (career.severstal.com, a Bitrix site; verified 2026-09 live). No public
// JSON API: /vacancies/?direction=it is server-rendered HTML with "card-vacancy" links (title,
// place, date) for the first page. Paging past the first page needs `X-Requested-With: XMLHttpRequest`
// on the same GET, which makes Bitrix return JSON {html, isLast, count} where `html` is the next
// fragment of the same card markup - we page with that until isLast. Job detail pages are plain
// server-rendered HTML using schema.org JobPosting microdata (itemprop) for description, location,
// experience and employment type; no salary is ever published. Apply is a Bitrix form POSTed to
// /webhook/response/ (name, lastname, email, phone, about, resume file) gated by a sessid + image
// captcha, no login - agent flow only, apply() omitted.
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, httpFetch, originOf, stripHtml } from "../../http.js";
import { makeVacancy, toISO } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const HOST = "career.severstal.com";
const DIRECTION = "it"; // IT direction filter on the listing; other directions are non-software roles

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === HOST) return { token: originOf(baseUrl) || `https://${HOST}` };
  return /career\.severstal\.com\/vacancies/i.test(html) ? { token: `https://${HOST}` } : null;
}

const CARD_RE =
  /<a href="(\/vacancies\/[a-z0-9_-]+\/)" target="_blank" class="card-vacancy vacancies-listing__card"[^>]*>([\s\S]*?)<\/a>/gi;
const TITLE_RE = /card-vacancy__title-text">([\s\S]*?)<\/h3>/i;
const PLACE_RE = /card-vacancy__place[^"]*">([\s\S]*?)<\/div>/i;

function parseCards(fragment: string, origin: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of fragment.matchAll(CARD_RE)) {
    const path = m[1];
    const block = m[2] ?? "";
    const title = stripHtml(TITLE_RE.exec(block)?.[1] ?? "").trim();
    if (!path || !title) continue;
    const place = stripHtml(PLACE_RE.exec(block)?.[1] ?? "").trim();
    out.push({
      externalId: atsId("site:severstal", path.replace(/^\/vacancies\/|\/$/g, "")),
      url: new URL(path, origin).toString(),
      title,
      company: "Severstal",
      location: place || undefined,
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const seen = new Map<string, Discovered>();
  for (let page = 1; page <= 50; page++) {
    const url = `${origin}/vacancies/?direction=${DIRECTION}&page=${page}`;
    const res = await httpFetch(url, { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const data = (await res.json()) as { html: string; isLast: boolean; count: number };
    for (const d of parseCards(data.html, origin)) seen.set(d.externalId, d);
    if (data.isLast) break;
  }
  return [...seen.values()];
}

const DESC_COL_RE = /vacancy-content__col" itemprop="description">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="vacancy-content__col">/i;
const LOCALITY_RE = /itemprop="addressLocality">([\s\S]*?)<\/span>/i;
const EMPLOYMENT_RE = /itemprop="employmentType">\s*<p[^>]*>([\s\S]*?)<\/p>/i;
const DATE_POSTED_RE = /itemprop="datePosted" content="([^"]*)"/i;

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(/itemprop="title">([\s\S]*?)<\/h3>/i.exec(html)?.[1] ?? "").trim() || d.title;
  const descriptionText = stripHtml(DESC_COL_RE.exec(html)?.[1] ?? "");
  const area = stripHtml(LOCALITY_RE.exec(html)?.[1] ?? "").trim() || d.location || "";
  const workFormat = stripHtml(EMPLOYMENT_RE.exec(html)?.[1] ?? "").trim();
  return makeVacancy({
    source: "site:severstal",
    externalId: d.externalId,
    url: d.url,
    title,
    company: "Severstal",
    descriptionText,
    area,
    workFormat,
    publishedAt: toISO(DATE_POSTED_RE.exec(html)?.[1] ?? null),
  });
}

export const client: ATSClientImpl = {
  kind: "site:severstal",
  verified: true,
  notes:
    "list via GET /vacancies/?direction=it&page=N with header X-Requested-With: XMLHttpRequest, an internal " +
    "Bitrix endpoint returning JSON {html, isLast, count} where html is a fragment of card-vacancy links " +
    "(no auth, ~8 IT jobs seen live); detail scraped from server-rendered /vacancies/{slug}/ HTML using " +
    "schema.org JobPosting microdata (description/jobLocation/employmentType), no salary published anywhere; " +
    "apply is a Bitrix form (name, lastname, email, phone, about, resume file) POSTed to /webhook/response/ " +
    "behind a sessid + image captcha, no login - agent flow only.",
  jobsUrl: (origin) => `${origin}/vacancies/?direction=${DIRECTION}`,
  detect,
  listJobs,
  fetchJob,
};
