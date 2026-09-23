// Dalli (dalli-service.com) courier/logistics careers site, a server-rendered WordPress page (no
// SPA bundle, no XHR API). Verified live 2026-09: base_url given as /company/vacancies/ 404s, the
// real list lives at GET /vacancy/ - a plain GET with every open vacancy inline, no pagination.
//   GET /vacancy/          -> HTML; each job is a <div class="page-vacancy__item"> with a
//                              <h3 class="page-vacancy__title-vacancy"> title, a
//                              <h4 class="page-vacancies__wage-item"> wage line, and a
//                              <a href="https://dalli-service.com/vacancy/{slug}/"> detail link.
//   GET /vacancy/{slug}/   -> HTML; full text lives in <div class="page-vacancy__info"><h3>{heading}
//                              </h3><div class="page-vacancy__block-vac">{html body}</div></div>
//                              blocks ("Что необходимо делать" / "Требования к кандидатам" /
//                              "Мы предлагаем" / ...), joined here into one description. The wage
//                              line repeats as an <h4> under the page title; no structured salary
//                              field anywhere, parsed here with a small best-effort regex.
// Only 6 vacancies live (courier/driver/warehouse), no software-dev roles - runner keyword filter
// will drop all of them, which is expected for a logistics company. Apply is a client-rendered React
// form (#form-vacancy-custom: name/phone/age/has-car/citizenship/schedule/metro) posting through an
// invisible-captcha-gated contact-form endpoint, no public JSON apply API -> agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://dalli-service.com";
const LIST_URL = `${ORIGIN}/vacancy/`;
const COMPANY = "Dalli";

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "dalli-service.com") return { token: ORIGIN };
  return /dalli-service\.com\/vacancy\//i.test(html) ? { token: ORIGIN } : null;
}

const ITEM_RE = /<div class="page-vacancies__item">([\s\S]*?)<\/div>\s*<\/div>/g;
const TITLE_RE = /<h3 class="page-vacancies__title-vacancy">([\s\S]*?)<\/h3>/;
const LINK_RE = /<a href="(https:\/\/dalli-service\.com\/vacancy\/[a-z0-9-]+\/)"/;

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(LIST_URL);
  const out: Discovered[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(ITEM_RE)) {
    const block = m[1] ?? "";
    const title = stripHtml(decodeEntities(TITLE_RE.exec(block)?.[1] ?? ""));
    const url = LINK_RE.exec(block)?.[1];
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const slug = url.replace(/\/$/, "").split("/").pop() ?? url;
    out.push({ externalId: atsId("site:dalli", slug), url, title, company: COMPANY });
  }
  return out;
}

const INFO_BLOCK_RE = /<div class="page-vacancy__info"><h3>([\s\S]*?)<\/h3>\s*<div class="page-vacancy__block-vac">([\s\S]*?)<\/div>\s*<\/div>/g;
const WAGE_RE = /<h4>([^<]*руб[^<]*)<\/h4>/i;
const H1_RE = /<h1 class="page-vacancy__title">([\s\S]*?)<\/h1>/;

/** "от 150 000 руб. в месяц" / "от 6 000 до 8 000 руб. за смену" -> best-effort {from,to,currency}. */
function parseWage(text: string): { from: number; to: number; currency: string } {
  const nums = [...text.matchAll(/\d[\d\s]*\d|\d/g)].map((m) => parseInt(m[0].replace(/\s/g, ""), 10));
  const currency = nums.length ? "RUB" : "";
  return { from: nums[0] ?? 0, to: nums[1] ?? 0, currency };
}

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(H1_RE.exec(html)?.[1] ?? "")) || d.title;
  const sections = [...html.matchAll(INFO_BLOCK_RE)]
    .map((m) => `${stripHtml(decodeEntities(m[1] ?? ""))}\n${stripHtml(decodeEntities(m[2] ?? ""))}`)
    .join("\n\n");
  const wage = parseWage(WAGE_RE.exec(html)?.[1] ?? "");
  return makeVacancy({
    source: "site:dalli",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText: sections,
    salaryFrom: wage.from,
    salaryTo: wage.to,
    currency: wage.currency,
  });
}

export const client: ATSClientImpl = {
  kind: "site:dalli",
  verified: true,
  notes:
    "no public JSON API; list is the full server-rendered GET /vacancy/ HTML (all open jobs, no " +
    "pagination, 6 live); detail sections (Что необходимо делать/Требования к кандидатам/Мы " +
    "предлагаем/...) scraped from GET /vacancy/{slug}/ page-vacancy__info blocks; wage is a free-text " +
    "h4 near the title, parsed best-effort, no structured salary field. All live jobs are " +
    "courier/driver/warehouse roles, no software-dev vacancies. Apply is a client-rendered React form " +
    "(name/phone/age/car/citizenship/schedule/metro) behind an invisible captcha, no public apply API " +
    "-> agent flow only.",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
