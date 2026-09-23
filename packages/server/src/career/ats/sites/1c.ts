// 1C careers site (1c.ru/rus/firm1c/vacan/, legacy JSP-era Bitrix-like site). No public JSON API.
// /vacan/search (no "direction" filter = "Все вакансии"/all jobs) lists every open vacancy as
// server-rendered <div class="vacancy_item"> cards, 5 per page, paginated via
// ?page=N&ajax=1 (ajax=1 returns just the list fragment). Pagination ends at the first page that
// returns zero items (verified 2026-09: 48 open vacancies across 10 pages). Detail pages at
// /vacan/vacancy/{id} are plain server-rendered HTML: title in <h1 class="page_title">, employment
// type/experience/work format in three fixed <span> pairs, full description in
// <div class="detail_txt">...<div class="detail_conditions"> (some descriptions include raw
// MS-Word-pasted markup, stripHtml handles it fine). No city/location field and no salary anywhere
// on the site (checked several jobs; only prose mentions of "зарплата", never a structured value).
// Apply is two links (a short web form at /vacan/form/short?vacancy={id}, and a longer profile
// builder at /vacan/form/long/{id}); no public JSON apply API found -> agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://1c.ru";
const LIST_PATH = "/rus/firm1c/vacan/search";
const COMPANY = "1C";

const text = (s: string | undefined): string => stripHtml(decodeEntities(s ?? "")).trim();

const ITEM_RE = /<a href="([^"]*\/vacan\/vacancy\/\d+)" class="vacancy_link">([\s\S]*?)<\/a>\s*<\/div>/gi;
const TITLE_RE = /<h3 class="vacancy_title">([\s\S]*?)<\/h3>/i;

function parseListing(html: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const href = m[1];
    const block = m[2] ?? "";
    const title = text(TITLE_RE.exec(block)?.[1]);
    if (!href || !title) continue;
    const id = href.match(/\/vacan\/vacancy\/(\d+)/)?.[1];
    if (!id) continue;
    out.push({
      externalId: atsId("site:1c", id),
      url: new URL(href, ORIGIN).toString(),
      title,
      company: COMPANY,
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let page = 1; ; page++) {
    const html = await getText(`${origin}${LIST_PATH}?page=${page}&ajax=1`);
    const items = parseListing(html);
    out.push(...items);
    if (items.length === 0) break;
  }
  return out;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  return hostOf(baseUrl) === "1c.ru" || /1c\.ru\/rus\/firm1c\/vacan\//.test(html) ? { token: ORIGIN } : null;
}

const FIELD_RE = (label: string) => new RegExp(`<span>${label}:</span>\\s*<span>([\\s\\S]*?)</span>`, "i");
const EMPLOYMENT_RE = FIELD_RE("Тип занятости");
const FORMAT_RE = FIELD_RE("Формат работы");
const DETAIL_TXT_RE = /<div class="detail_txt">([\s\S]*?)<div class="detail_conditions">/i;

async function fetchJob(origin: string, d: Discovered) {
  const html = await getText(d.url);
  const h1 = text(/<h1 class="page_title">([\s\S]*?)<\/h1>/i.exec(html)?.[1]);
  return makeVacancy({
    source: "site:1c",
    externalId: d.externalId,
    url: d.url,
    title: h1 || d.title,
    company: COMPANY,
    descriptionText: text(DETAIL_TXT_RE.exec(html)?.[1]),
    workFormat: text(FORMAT_RE.exec(html)?.[1]) || text(EMPLOYMENT_RE.exec(html)?.[1]),
  });
}

export const client: ATSClientImpl = {
  kind: "site:1c",
  verified: true,
  notes:
    "legacy server-rendered site, no public JSON API; /vacan/search (no direction filter) lists ALL open jobs, " +
    "5/page, paginated via ?page=N&ajax=1 until an empty page (48 jobs across 10 pages on 2026-09-23); " +
    "detail page has title/employment type/experience/work format + full description text, no city field, " +
    "no salary anywhere on the site; apply is two link-based forms (/vacan/form/short, /vacan/form/long), " +
    "no public JSON apply API -> agent flow only",
  jobsUrl: (origin) => `${origin}${LIST_PATH}`,
  detect,
  listJobs,
  fetchJob,
};
