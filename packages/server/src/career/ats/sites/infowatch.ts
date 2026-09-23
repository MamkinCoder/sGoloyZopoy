// InfoWatch careers site (www.infowatch.ru), a server-rendered Drupal 10 site. No public JSON API:
// GET /o-kompanii-infowatch/career/vakansii returns every open vacancy as plain HTML cards
// (`<div class="vacancies-table__type-row card-vac card-vac_catalog">`), department-tabbed with
// `data-filter` but all filters render on the same page - no pagination, no AJAX. Verified live
// 2026-09 (14 open jobs). Detail page at /o-kompanii-infowatch/career/vakansii/{id} has no JSON-LD
// JobPosting, just an Organization schema; the full description is plain HTML inside
// `<p class="news-detail__text">` and the city (if any) sits in `<span class="news-detail__date">`.
// No salary ever exposed. No apply form on the vacancy page itself (only a generic "request a call"
// modal unrelated to the job) - responding happens off-site, so apply() is omitted.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://www.infowatch.ru";
const LISTING_PATH = "/o-kompanii-infowatch/career/vakansii";

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "www.infowatch.ru" ? { token: ORIGIN } : null;
}

const CARD_RE =
  /<div class="vacancies-table__type-row card-vac card-vac_catalog"[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<p>([^<]*)<span><\/span>([^<]*)<\/p>/g;

function parseListing(html: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of html.matchAll(CARD_RE)) {
    const href = m[1] ?? "";
    const title = stripHtml(decodeEntities(m[2] ?? "")).trim();
    const city = decodeEntities(m[4] ?? "").trim();
    if (!href || !title) continue;
    const url = new URL(href, ORIGIN).toString();
    const id = url.split("/").filter(Boolean).pop() ?? "";
    if (!id) continue;
    out.push({ externalId: atsId("site:infowatch", id), url, title, company: "InfoWatch", location: city || undefined });
  }
  return out;
}

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(`${ORIGIN}${LISTING_PATH}`);
  return parseListing(html);
}

const CITY_RE = /<span class="news-detail__date">([\s\S]*?)<\/span>/;
const TITLE_RE = /<h1 class="news-detail__title[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/;
const DESCRIPTION_RE = /<p class="news-detail__text">([\s\S]*?)<\/p>\s*<\/div>/;

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(TITLE_RE.exec(html)?.[1] ?? "")) || d.title;
  const city = stripHtml(decodeEntities(CITY_RE.exec(html)?.[1] ?? ""));
  const description = stripHtml(decodeEntities(DESCRIPTION_RE.exec(html)?.[1] ?? ""));
  return makeVacancy({
    source: "site:infowatch",
    externalId: d.externalId,
    url: d.url,
    title,
    company: "InfoWatch",
    descriptionText: description,
    area: city || d.location || "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:infowatch",
  verified: true,
  notes:
    "no public JSON API; GET /o-kompanii-infowatch/career/vakansii lists every open job as server-rendered " +
    "HTML cards, no pagination (14 jobs on 2026-09); detail page has no JobPosting JSON-LD, description " +
    "is plain HTML inside <p class=\"news-detail__text\">, city (if any) in <span class=\"news-detail__date\">; " +
    "no salary ever exposed; no apply form on the vacancy page (only an unrelated 'request a call' modal) -> agent flow / off-site",
  jobsUrl: () => `${ORIGIN}${LISTING_PATH}`,
  detect,
  listJobs,
  fetchJob,
};
