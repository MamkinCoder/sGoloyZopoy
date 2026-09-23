// RT Solar (Ростелеком-Солар, cybersecurity) careers site. Public site rt-solar.ru/career/ is
// currently in whole-site maintenance mode ("Плановые технические работы", 2026-09), but its
// sitemap still lists live /about_company/career/<id>/ pages, which 302-redirect to the real,
// separate careers subdomain team.rt-solar.ru/<id>/ - that subdomain is unaffected and live.
// Server-rendered Bitrix, no public JSON API. Listing:
//   GET /vacancies/?PAGEN_1=<n>  -> full HTML page (plain GET works fine without the bxajaxid the
//                                   "Показать еще" button sends - that only switches to a partial
//                                   ajax fragment). 5 jobs/page; last page has no "Показать еще".
// Each <li class="vacancies__item"> card has city, post date, title and detail url, no description.
// Detail: GET /vacancies/{id}/ -> plain text description (Обязанности/Требования/... separated by
// <br/>) inside a single unnested <div class="vacancies-details-body">, city repeated in the header.
// No salary anywhere. Apply is a Bitrix POST form (resume_form: name/phone/email, resume file,
// hidden vacancy id/title, bxajaxid/sessid CSRF) behind "Откликнуться" - no public apply API,
// agent flow only. Verified live 2026-09 (36 open vacancies).
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://team.rt-solar.ru";
const COMPANY = "Solar";

const ITEM_RE = /<li class="vacancies__item[^"]*">/g;
const LOCATION_RE = /vacancies-information_location">\s*<p[^>]*>([^<]*)<\/p>/;
const TITLE_LINK_RE = /<a class="link[^"]*vacancies__title"[^>]*href="(\/vacancies\/\d+\/)"[^>]*>([\s\S]*?)<\/a>/;
const MORE_BUTTON_RE = /vacanciesMore\(/;

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (host === "team.rt-solar.ru") return { token: ORIGIN };
  if (host === "rt-solar.ru" || host === "www.rt-solar.ru") return { token: ORIGIN };
  return /team\.rt-solar\.ru\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

// Cards are <li class="vacancies__item ...">...</li> with no nested <li>, so split on card start.
function parsePage(html: string): Discovered[] {
  const starts = [...html.matchAll(ITEM_RE)];
  const out: Discovered[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]?.index ?? 0;
    const to = starts[i + 1]?.index ?? html.length;
    const block = html.slice(from, to);
    const link = TITLE_LINK_RE.exec(block);
    if (!link) continue;
    const title = stripHtml(decodeEntities(link[2] ?? "")).trim();
    if (!title) continue;
    const location = decodeEntities(LOCATION_RE.exec(block)?.[1] ?? "").trim();
    const id = link[1]?.split("/").filter(Boolean).pop() ?? "";
    out.push({
      externalId: atsId("site:solar", id),
      url: `${ORIGIN}${link[1]}`,
      title,
      company: COMPANY,
      location: location || undefined,
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const seen = new Map<string, Discovered>();
  for (let page = 1; ; page++) {
    const html = await getText(`${origin}/vacancies/?PAGEN_1=${page}`);
    const jobs = parsePage(html);
    if (jobs.length === 0) break;
    for (const j of jobs) seen.set(j.externalId, j);
    if (!MORE_BUTTON_RE.test(html)) break;
  }
  return [...seen.values()];
}

const DETAIL_HEADER_LOCATION_RE = /vacancies-details-header__wrapper">\s*<div class="vacancies-information\s+vacancies-information_location">\s*<p[^>]*>([^<]*)<\/p>/;

function descriptionOf(html: string): string {
  const start = html.indexOf('class="vacancies-details-body"');
  if (start === -1) return "";
  const bodyStart = html.indexOf(">", start) + 1;
  const bodyEnd = html.indexOf("</div>", bodyStart);
  if (bodyEnd === -1) return "";
  return stripHtml(decodeEntities(html.slice(bodyStart, bodyEnd)));
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const area = decodeEntities(DETAIL_HEADER_LOCATION_RE.exec(html)?.[1] ?? "").trim() || d.location || "";
  return makeVacancy({
    source: "site:solar",
    externalId: d.externalId,
    url: d.url,
    title: d.title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
    area,
  });
}

export const client: ATSClientImpl = {
  kind: "site:solar",
  verified: true,
  notes:
    "no public JSON API; rt-solar.ru/career/ itself is in whole-site maintenance mode but the real " +
    "careers subdomain team.rt-solar.ru is live and unaffected; list via GET /vacancies/?PAGEN_1=<n> " +
    "(plain GET, 5 jobs/page, stop when no 'Показать еще' vacanciesMore(...) button); detail is plain " +
    "text inside a single unnested <div class=\"vacancies-details-body\"> on GET /vacancies/{id}/; " +
    "no salary ever published. Apply is a Bitrix POST form (name/phone/email, resume file, hidden " +
    "vacancy id/title, bxajaxid+sessid CSRF) behind \"Откликнуться\" - no public apply API -> agent flow only.",
  jobsUrl: (origin) => `${origin}/vacancies/?PAGEN_1=1`,
  detect,
  listJobs,
  fetchJob,
};
