// NLMK careers site (career.nlmk.com, Bitrix CMS). No public JSON API. GET /vacancy/ (no filters,
// server-rendered) lists ALL open vacancies for the whole group in one page as <div class="vacancies-item">
// cards - no pagination markers seen (66 jobs on one page, verified 2026-09). Card fields: title, area
// (city), office/subsidiary (used as company - jobs span NLMK subsidiaries like "НЛМК-Информационные
// технологии", "Стойленский ГОК"), and a dd.mm.yyyy publish date. Detail pages at /vacancy/detail/{slug}/
// are plain server-rendered HTML: title in <h1 class="dynamic-text">, work format/experience in
// <ul class="specialist__description-vacancies-list"> label/value pairs, full description in
// <div class="specialist__right-block-text">. No salary anywhere on the site (checked several jobs,
// including the detail page - never a structured value). Apply is a Bitrix account-registration form
// (name/email/password + resume upload, POST back to the same detail URL) with a captcha widget on the
// full site register flow -> agent flow only, no public JSON apply API found.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://career.nlmk.com";
const LIST_PATH = "/vacancy/";
const GROUP_COMPANY = "NLMK";

const text = (s: string | undefined): string => stripHtml(decodeEntities(s ?? "")).trim();

const ITEM_RE =
  /<a href="(\/vacancy\/detail\/[a-z0-9_-]+\/)"><h5\s+class="vacancies-item__title text-24">([\s\S]*?)<\/h5><\/a>\s*<div class="vacancies-item__info[^"]*">\s*<div class="vacancies-item__elem text-16">([\s\S]*?)<\/div>\s*<div class="vacancies-item__elem text-16">([\s\S]*?)<\/div>/gi;

function parseListing(html: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const href = m[1];
    const title = text(m[2]);
    const area = text(m[3]);
    const office = text(m[4]);
    if (!href || !title) continue;
    const slug = href.match(/\/vacancy\/detail\/([a-z0-9_-]+)\//)?.[1];
    if (!slug) continue;
    out.push({
      externalId: atsId("site:nlmk", slug),
      url: new URL(href, ORIGIN).toString(),
      title,
      company: office || GROUP_COMPANY,
      location: area || undefined,
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}${LIST_PATH}`);
  return parseListing(html);
}

function detect(baseUrl: string, html: string): { token: string } | null {
  return hostOf(baseUrl) === "career.nlmk.com" || /career\.nlmk\.com\/vacancy\//.test(html) ? { token: ORIGIN } : null;
}

const H1_RE = /<h1 class="dynamic-text">([\s\S]*?)<\/h1>/i;
const FIELD_RE = (label: string) =>
  new RegExp(`<span class="specialist__span-left">${label}:</span>\\s*<span class="specialist__span-right">([\\s\\S]*?)</span>`, "i");
const SCHEDULE_RE = FIELD_RE("График");
const DESCRIPTION_RE = /<div class="specialist__right-block-text">([\s\S]*?)<div id="anchor"/i;

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const title = text(H1_RE.exec(html)?.[1]) || d.title;
  return makeVacancy({
    source: "site:nlmk",
    externalId: d.externalId,
    url: d.url,
    title,
    company: d.company || GROUP_COMPANY,
    descriptionText: text(DESCRIPTION_RE.exec(html)?.[1]),
    area: d.location ?? "",
    workFormat: text(SCHEDULE_RE.exec(html)?.[1]),
  });
}

export const client: ATSClientImpl = {
  kind: "site:nlmk",
  verified: true,
  notes:
    "Bitrix CMS, no public JSON API; GET /vacancy/ (no filters) server-renders ALL open group vacancies " +
    "on one page, no pagination seen (66 jobs on 2026-09-23); office/subsidiary field used as company " +
    "(varies by legal entity within the group); detail page has title/schedule + full description text, " +
    "no salary anywhere on the site; apply is a Bitrix account-registration form (name/email/password, " +
    "resume upload) behind a captcha widget -> agent flow only",
  jobsUrl: (origin) => `${origin}${LIST_PATH}`,
  detect,
  listJobs,
  fetchJob,
};
