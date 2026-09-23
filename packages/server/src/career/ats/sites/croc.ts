// CROC careers site. base_url career.croc.ru (NXDOMAIN) - the real site is careers.croc.ru, a
// Bitrix site, server-rendered, no JSON API. Verified live 2026-09 (~100 open vacancies).
//   GET /vacancies/            -> lists a small preview per category plus a <select name="sections">
//     with every category's numeric id (value=N). The unfiltered page truncates most categories.
//   GET /vacancies/?sections=N -> full unpaginated list of that one category's jobs (checked the
//     largest category, 18 jobs, all render with no "show more" - pagination.js's .jsPagShowMore
//     button never appears at current volumes). listJobs unions every section's jobs by url.
//   GET /vacancies/<slug>/     -> job detail, plain server-rendered HTML: h1 title, a tag <ul> of
//     free-text chips (experience/employment/work format/city, order and count vary - classified
//     by keyword), then description as an intro block plus H4-titled sections (Ваши задачи, Наши
//     ожидания, Будет плюсом, Мы предлагаем...). No salary field anywhere (list or detail).
// Apply is a same-page Bitrix webform (name, email, phone, resume file) posted back to the vacancy
// URL, sessid CSRF token, no login - no public JSON apply API, agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://careers.croc.ru";
const LISTING_URL = `${ORIGIN}/vacancies/`;
const COMPANY = "CROC";

const SECTION_OPTION_RE = /name="sections"[\s\S]{0,6000}?<\/select>/;
const SECTION_VALUE_RE = /value="(\d+)">\s*[^<]+?\s*<\/option>/g;
const ITEM_RE = /<a class="size-normal size-md-smaller" target="_blank" href="(\/vacancies\/[a-z0-9_-]+\/)">\s*<span>([^<]*)<\/span>/g;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "careers.croc.ru") return { token: ORIGIN };
  return /careers\.croc\.ru\/vacanc/i.test(html) ? { token: ORIGIN } : null;
}

function parseSectionIds(html: string): string[] {
  const block = SECTION_OPTION_RE.exec(html)?.[0] ?? "";
  return [...block.matchAll(SECTION_VALUE_RE)].map((m) => m[1] ?? "").filter(Boolean);
}

function parseItems(html: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const path = m[1];
    const title = stripHtml(decodeEntities(m[2] ?? "")).trim();
    if (!path || !title) continue;
    const slug = path.split("/").filter(Boolean).pop() ?? path;
    out.push({ externalId: atsId("site:croc", slug), url: `${ORIGIN}${path}`, title, company: COMPANY });
  }
  return out;
}

async function listJobs(): Promise<Discovered[]> {
  const root = await getText(LISTING_URL);
  const sectionIds = parseSectionIds(root);
  const seen = new Map<string, Discovered>();
  for (const d of parseItems(root)) seen.set(d.externalId, d);
  for (const id of sectionIds) {
    const html = await getText(`${LISTING_URL}?sections=${id}`);
    for (const d of parseItems(html)) seen.set(d.externalId, d);
  }
  return [...seen.values()];
}

const TAG_RE = /<ul class="pl-none mb-normal weight-400">([\s\S]*?)<\/ul>/;
const TAG_ITEM_RE = /<li[^>]*>\s*([^<]+?)\s*<\/li>/g;

function classifyTags(tags: string[]): { area: string; workFormat: string } {
  let area = "";
  let workFormat = "";
  for (const tag of tags) {
    if (/лет|год|опыта/i.test(tag)) continue; // experience, not published in Vacancy
    if (/занятост/i.test(tag)) continue; // employment type, folded into workFormat below if relevant
    if (/удал|офис|гибрид/i.test(tag)) {
      workFormat = workFormat ? `${workFormat}, ${tag}` : tag;
    } else {
      area = area ? `${area}, ${tag}` : tag; // remaining chip is the city
    }
  }
  return { area, workFormat };
}

const SECTION_BLOCK_RE = /<div class="mb-big mb-md-small vacancy-detail__content-main-item">\s*<h4[^>]*>([^<]*)<\/h4>\s*<ul>([\s\S]*?)<\/ul>\s*<\/div>/g;
const INTRO_RE = /<div class="mb-big mb-md-biggest vacancy-detail__content-main-text-block">([\s\S]*?)<\/div>/;

function descriptionOf(html: string): string {
  const parts: string[] = [];
  const intro = stripHtml(decodeEntities(INTRO_RE.exec(html)?.[1] ?? ""));
  if (intro) parts.push(intro);
  for (const m of html.matchAll(SECTION_BLOCK_RE)) {
    const heading = stripHtml(decodeEntities(m[1] ?? "")).trim();
    const body = stripHtml(decodeEntities(m[2] ?? ""));
    if (body) parts.push(heading ? `${heading}:\n${body}` : body);
  }
  return parts.join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "")).trim() || d.title;
  const tags = [...(TAG_RE.exec(html)?.[1] ?? "").matchAll(TAG_ITEM_RE)].map((m) => decodeEntities(m[1] ?? "").trim());
  const { area, workFormat } = classifyTags(tags);
  return makeVacancy({
    source: "site:croc",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
    area,
    workFormat,
  });
}

export const client: ATSClientImpl = {
  kind: "site:croc",
  verified: true,
  notes:
    "base_url career.croc.ru is NXDOMAIN; real site is careers.croc.ru (Bitrix, server-rendered, no JSON API); " +
    "GET /vacancies/ discovers category ids from its <select name=\"sections\">, GET /vacancies/?sections=N lists " +
    "that category unpaginated (largest seen category, 18 jobs, rendered fully with no show-more page needed - " +
    "revisit if a category grows past what one page renders); listJobs unions all categories by url. Job detail " +
    "chips (experience/employment/work format/city) are untyped free text classified by keyword; experience and " +
    "employment type are dropped (no Vacancy field for them), work format and city are kept. No salary field " +
    "anywhere. Apply is a same-page Bitrix webform (ФИО, email, phone, resume file) with a sessid CSRF token, " +
    "no login - no public JSON apply API found, agent flow only.",
  jobsUrl: () => LISTING_URL,
  detect,
  listJobs,
  fetchJob,
};
