// CDEK careers site (rabota.cdek.ru; the base_url career.cdek.ru given for this integration does
// not resolve - DNS NXDOMAIN, verified 2026-09). Server-rendered site with one JSON endpoint used by
// its own client-side filter widget, found in /js/front.js and confirmed live 2026-09:
//   POST /api/vacancies  body {page, query, subdirections, newbie, cities:{is_remote,all_cities,ids},
//                              direction?} -> {vacancies: "<article>...</article>..." (HTML string),
//                              pagination:{currentPage,totalPages}}
//   NOTE: subdirections must be [] (not null) or the endpoint 500s.
// direction:"it" scopes the list to the IT rubric (dev/analytics/admin/support) in one page; omitting
// `direction` paginates all ~200 vacancies (couriers, warehouse, sales, ...) across ~20 pages - we
// read every direction since the runner filters by keyword afterwards, same as other clients.
// Each job's full text/salary/schedule/address is server-rendered HTML at GET /vacancies/item/{id}.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, extractLinks, getText, hostOf, postJson, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://rabota.cdek.ru";
const LIST_API = `${ORIGIN}/api/vacancies`;
const COMPANY = "CDEK";
const PAGE_CAP = 40; // generous ceiling over the ~20 pages observed live

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "rabota.cdek.ru") return { token: ORIGIN };
  return /rabota\.cdek\.ru\/(vacancies|direction)/i.test(html) ? { token: ORIGIN } : null;
}

interface ListPage {
  vacancies: string; // HTML fragment: a run of <article class="vacancies__list-item">...
  pagination: { currentPage: number; totalPages: number };
}

const ARTICLE_RE = /<article class="vacancies__list-item">([\s\S]*?)<\/article>/g;
const PRICE_RE = /<p class="vacancies__list-item-info-price">([^<]*)<\/p>/;
const ADDRESS_RE = /<p class="vacancies__list-item-address-street">([\s\S]*?)<\/p>/;
const REMOTE_RE = /vacancies__list-item-tags-item _remote/;

function parseListPage(html: string, origin: string): Discovered[] {
  const out: Discovered[] = [];
  for (const article of html.matchAll(ARTICLE_RE)) {
    const block = article[1] ?? "";
    const link = extractLinks(block, origin)[0];
    if (!link) continue;
    const id = /\/vacancies\/item\/(\d+)/.exec(link.href)?.[1];
    if (!id || !link.text) continue;
    const address = stripHtml(decodeEntities(ADDRESS_RE.exec(block)?.[1] ?? "")).replace(/\s+/g, " ").trim();
    out.push({
      externalId: atsId("site:cdek", id),
      url: link.href,
      title: link.text,
      company: COMPANY,
      location: address || undefined,
      raw: { priceText: PRICE_RE.exec(block)?.[1] ?? "", isRemote: REMOTE_RE.test(block) },
    });
  }
  return out;
}

async function listJobs(): Promise<Discovered[]> {
  const seen = new Map<string, Discovered>();
  for (let page = 1; page <= PAGE_CAP; page++) {
    const body = { page, query: null, subdirections: [], newbie: null, cities: { is_remote: null, all_cities: true, ids: [] } };
    const data = await postJson<ListPage>(LIST_API, body);
    for (const d of parseListPage(data.vacancies, ORIGIN)) seen.set(d.externalId, d);
    if (page >= data.pagination.totalPages) break;
  }
  return [...seen.values()];
}

// "90 000 - 140 000 Руб." | "от 85 400 Руб." | "" (unset)
function parsePrice(text: string): { salaryFrom: number; salaryTo: number; currency: string } {
  const nums = [...text.matchAll(/[\d\s]{2,}/g)].map((m) => Number(m[0].replace(/\s/g, ""))).filter((n) => n > 0);
  if (nums.length === 0) return { salaryFrom: 0, salaryTo: 0, currency: "" };
  return { salaryFrom: nums[0] ?? 0, salaryTo: nums.length > 1 ? (nums[1] ?? 0) : 0, currency: "RUR" };
}

const HEADING_RE = /<h1 class="vacancy__heading">([\s\S]*?)<\/h1>/;
const DETAIL_PRICE_RE = /<p class="vacancy__price">([^<]*)<\/p>/;
const SCHEDULE_RE = /<p class="vacancy__schedule">([^<]*)<\/p>/;
const DETAIL_ADDRESS_RE = /<p class="vacancy__map-address-item[^"]*">([\s\S]*?)<\/p>/;
const DESCR_RE = /<div class="vacancy__descr">([\s\S]*?)<\/div>\s*(?:<section class="vacancy__infobox"|<\/div>\s*<\/div>)/;

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(HEADING_RE.exec(html)?.[1] ?? "")) || d.title;
  const { salaryFrom, salaryTo, currency } = parsePrice(DETAIL_PRICE_RE.exec(html)?.[1] ?? "");
  const address = stripHtml(decodeEntities(DETAIL_ADDRESS_RE.exec(html)?.[1] ?? "")).replace(/\s+/g, " ").trim();
  const schedule = stripHtml(SCHEDULE_RE.exec(html)?.[1] ?? "");
  const remote = REMOTE_RE.test(html);
  const workFormat = [remote ? "можно удалённо" : "", schedule].filter(Boolean).join(", ");
  return makeVacancy({
    source: "site:cdek",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText: stripHtml(decodeEntities(DESCR_RE.exec(html)?.[1] ?? "")),
    area: address || d.location || "",
    workFormat,
    salaryFrom,
    salaryTo,
    currency,
  });
}

export const client: ATSClientImpl = {
  kind: "site:cdek",
  verified: true,
  notes:
    "career.cdek.ru (given base_url) does not resolve; the real site is rabota.cdek.ru, a server-" +
    "rendered custom site. List via POST /api/vacancies (subdirections must be [] or it 500s; add " +
    'direction:"it" to scope to IT roles, omit to page through all ~200 openings across every ' +
    "department - listJobs returns everything, runner filters by keyword); response is an HTML " +
    "fragment of <article> job cards, paginated (pagination.totalPages). Detail is server-rendered " +
    "GET /vacancies/item/{id} (title/price/schedule/address/description, no JSON-LD). Salary text is " +
    "free-form ('X - Y Руб.' / 'от X Руб.' / blank), parsed with a simple number scan. Apply is an " +
    "in-page HTML form (#form-apply) with a Laravel CSRF _token and vacancy_id, posted same-origin - " +
    "no public JSON apply API -> agent flow only, no apply(). www.cdek.ru/ru/company/vacancy (the " +
    "corporate-site vacancy page, which just redirects here) is behind a Servicepipe JS challenge; " +
    "rabota.cdek.ru itself is not.",
  jobsUrl: () => LIST_API,
  detect,
  listJobs,
  fetchJob,
};
