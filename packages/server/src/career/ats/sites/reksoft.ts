// Reksoft careers site. https://www.reksoft.ru/career/ redirects to www.reksoft.com (WordPress
// corporate site with no job list); the real careers site is the career.reksoft.com WordPress
// subdomain (verified live 2026-09). No public JSON API and the wp-json REST API is locked
// (401 rest_forbidden). /vacancies/ server-renders every open role as a single unpaginated list
// (empty pagination__list, 5/5 live). Each card links to a detail page at /vacancies/<slug>/ with
// no JobPosting JSON-LD (only WebPage/BreadcrumbList schema) - full text is scraped from the
// .title-list__row blocks (Задачи/Требования/...). No salary is ever published. Apply is a contact
// person (Telegram/email/phone) per vacancy, no application form or API found -> agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://www.career.reksoft.com"; // moved from career.reksoft.com (301) in 2026-09
const COMPANY = "Reksoft";
const VACANCIES_URL = `${ORIGIN}/vacancies/`;

const CARD_START_RE = /<a class="vacancy-item" href="(https:\/\/(?:www\.)?career\.reksoft\.com\/vacancies\/[a-z0-9-]+\/)">/gi;
const TITLE_RE = /<div class="vacancy-item__title">([\s\S]*?)<\/div>/i;
const FORMAT_RE = /<span>Формат<\/span>\s*<span>([^<]*)<\/span>/i;
const TAGS_RE = /<div class="vacancy-item__tags">([\s\S]*?)<\/div>\s*<\/a>/i;
const TAG_ITEM_RE = /<div>([^<]*)<\/div>/g;
const ID_RE = /\/vacancies\/([a-z0-9-]+)\/$/i;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (/^(www\.)?career\.reksoft\.com$/.test(hostOf(baseUrl))) return { token: ORIGIN };
  return /(www\.)?career\.reksoft\.com\/vacancies\//i.test(html) ? { token: ORIGIN } : null;
}

const idFromUrl = (url: string): string => ID_RE.exec(url)?.[1] ?? url;

// Each card is a run of text between one vacancy-item <a> and the next (or end of the list),
// same "split on the repeating start marker" approach as avito.ts/vkusvill.ts.
function parseList(html: string): Discovered[] {
  const starts = [...html.matchAll(CARD_START_RE)];
  const out: Discovered[] = [];
  for (let i = 0; i < starts.length; i++) {
    const url = starts[i]?.[1];
    const from = starts[i]?.index ?? 0;
    const to = starts[i + 1]?.index ?? html.length;
    if (!url) continue;
    const block = html.slice(from, to);
    const title = stripHtml(decodeEntities(TITLE_RE.exec(block)?.[1] ?? "")).trim();
    if (!title) continue;
    const format = stripHtml(decodeEntities(FORMAT_RE.exec(block)?.[1] ?? "")).trim();
    const tagsBlock = TAGS_RE.exec(block)?.[1] ?? "";
    const tags = [...tagsBlock.matchAll(TAG_ITEM_RE)].map((m) => stripHtml(decodeEntities(m[1] ?? "")).trim()).filter(Boolean);
    out.push({
      externalId: atsId("site:reksoft", idFromUrl(url)),
      url,
      title,
      company: COMPANY,
      location: tags[0] || undefined,
      raw: { workFormat: format },
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/vacancies/`);
  return parseList(html);
}

const TITLE_LIST_RE = /<div class="title-list">([\s\S]*?)<\/section>/i;
const ROW_START_RE = /<div class="title-list__row"[^>]*>/gi;
const HERO_TEXT_RE = /<div class="vacancy-hero__text"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i;

// Rows (Задачи/Требования/...) are siblings with no distinguishing end marker, so split on the
// repeating start marker like avito.ts/vkusvill.ts do for job cards - robust to nesting depth.
// Bounded to the .title-list container's own <section> (not end-of-html), since a job with only
// one row (e.g. just "Требования") would otherwise swallow the benefits list and the recruiter's
// contact details (phone/email) that follow on the page.
function descriptionOf(html: string): string {
  const intro = stripHtml(decodeEntities(HERO_TEXT_RE.exec(html)?.[1] ?? ""));
  const container = TITLE_LIST_RE.exec(html)?.[1] ?? "";
  const starts = [...container.matchAll(ROW_START_RE)];
  const sections: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]?.index ?? 0;
    const to = starts[i + 1]?.index ?? container.length;
    const body = stripHtml(decodeEntities(container.slice(from, to)));
    if (body) sections.push(body);
  }
  return [intro, ...sections].filter(Boolean).join("\n\n");
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const cached = d.raw as { workFormat?: string } | undefined;
  const h1 = stripHtml(decodeEntities(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ""));
  return makeVacancy({
    source: "site:reksoft",
    externalId: d.externalId,
    url: d.url,
    title: h1 || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
    area: d.location ?? "",
    workFormat: cached?.workFormat ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:reksoft",
  verified: true,
  notes:
    "reksoft.ru/career redirects to reksoft.com (no jobs there); real careers site is the career.reksoft.com " +
    "WordPress subdomain. No public JSON API, wp-json REST is locked (401). /vacancies/ server-renders every " +
    "open role unpaginated (empty pagination list, 5/5 confirmed live). Detail pages have no JobPosting JSON-LD " +
    "(only WebPage/BreadcrumbList) - full text scraped from .title-list__row blocks (Задачи/Требования/...). " +
    "No salary ever published. Apply is a named contact person (Telegram/email/phone) per vacancy, no form or " +
    "API found -> agent flow only.",
  jobsUrl: () => VACANCIES_URL,
  detect,
  listJobs,
  fetchJob,
};
