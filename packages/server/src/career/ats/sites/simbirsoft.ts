// SimbirSoft careers site (www.simbirsoft.com/vacancies/, 1C-Bitrix). No public JSON API.
//   GET /ajax/vacancy/?page=<n>  (needs header X-Requested-With: XMLHttpRequest, else 404) ->
//                                    server-rendered HTML fragment, 12 cards/page (href, title,
//                                    section); a "Показать ещё" link with data-value="<n+1>" means
//                                    there's a next page, absence means it was the last one (22 jobs,
//                                    2 pages, on 2026-09).
//   GET /vacancies/{slug}/       -> full server-rendered detail page: title (h1#vacancy-name), salary
//                                    (.dv-ls-salary, "По договоренности" when unset), experience/
//                                    location/employment type (.is-list-type-b .l-key/.l-value pairs),
//                                    full description (section.is-style, plain HTML).
// No apply API: applying is a classic Bitrix multi-field HTML POST (name, phone, resume file upload)
// gated by a CSRF sessid -> agent flow only, apply() omitted. Verified live 2026-09.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, httpFetch, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const KIND = "site:simbirsoft";
const ORIGIN = "https://www.simbirsoft.com";
const LIST_API = `${ORIGIN}/ajax/vacancy/`;
const COMPANY = "SimbirSoft";

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:simbirsoft" is itself two
// colon-segments, so we peel our own known prefix instead (same fix as sites/beeline.ts).
const KIND_PREFIX = `${KIND}:`;
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

const CARD_RE = /<a class="l-item" href="(\/vacancies\/[^"]+\/)">[\s\S]*?<div class="l-item-name">\s*([\s\S]*?)<\/div>/g;
const SHOW_MORE_RE = /data-click="showMore" data-value="(\d+)"/;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "www.simbirsoft.com" || hostOf(baseUrl) === "simbirsoft.com") return { token: ORIGIN };
  return /www\.simbirsoft\.com\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

const slugOf = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

function parsePage(html: string): { jobs: Discovered[]; nextPage: number | null } {
  const jobs: Discovered[] = [];
  for (const m of html.matchAll(CARD_RE)) {
    const path = m[1];
    const title = stripHtml(decodeEntities(m[2] ?? "")).trim();
    if (!path || !title) continue;
    const slug = slugOf(path);
    jobs.push({ externalId: atsId(KIND, slug), url: `${ORIGIN}${path}`, title, company: COMPANY });
  }
  const next = SHOW_MORE_RE.exec(html)?.[1];
  return { jobs, nextPage: next ? Number(next) : null };
}

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  let page: number | null = 1;
  while (page !== null) {
    const url = `${LIST_API}?page=${page}`;
    const res = await httpFetch(url, { headers: { "x-requested-with": "XMLHttpRequest" } });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const { jobs, nextPage } = parsePage(await res.text());
    out.push(...jobs);
    page = nextPage;
  }
  return out;
}

/** Value of the .l-item whose .l-key text matches key (words may be joined by a space or &nbsp;). */
function listValue(html: string, key: string): string {
  const keyPattern = key.split(" ").join("(?:\\s|&nbsp;)+");
  const re = new RegExp(
    `<div class="l-key">\\s*${keyPattern}\\s*</div>\\s*<div class="l-value">([\\s\\S]*?)</div>`,
    "i",
  );
  return stripHtml(decodeEntities(re.exec(html)?.[1] ?? ""));
}

const SALARY_RE = /<div class="dv-ls-salary[^"]*">([\s\S]*?)<\/div>/;
const DESCRIPTION_RE = /<section class="is-style"[^>]*>([\s\S]*?)<\/section>/;

// Salary text is either "По договоренности" (nothing), "от N руб.", "до N руб." or "от N до M руб.".
function parseSalary(text: string): { from: number; to: number; currency: string } {
  const nums = [...text.matchAll(/\d[\d\s]*\d|\d/g)]
    .map((m) => Number(m[0].replace(/\s/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return { from: 0, to: 0, currency: "" };
  const hasFrom = /от/i.test(text);
  const hasTo = /до/i.test(text);
  if (hasFrom && hasTo && nums.length > 1) return { from: nums[0]!, to: nums[1]!, currency: "RUB" };
  if (hasFrom) return { from: nums[0]!, to: 0, currency: "RUB" };
  if (hasTo) return { from: 0, to: nums[0]!, currency: "RUB" };
  return { from: 0, to: 0, currency: "RUB" };
}

async function fetchJob(_token: string, d: Discovered) {
  const slug = localId(d.externalId);
  const url = `${ORIGIN}/vacancies/${slug}/`;
  const html = await getText(url);

  const title = stripHtml(decodeEntities(/data-vacancy-name="([^"]*)"/.exec(html)?.[1] ?? "")) || d.title;
  const salaryText = stripHtml(decodeEntities(SALARY_RE.exec(html)?.[1] ?? ""));
  const { from, to, currency } = parseSalary(salaryText);
  const description = stripHtml(decodeEntities(DESCRIPTION_RE.exec(html)?.[1] ?? ""));
  const area = listValue(html, "Местоположение");
  const workFormat = listValue(html, "Тип занятости");

  return makeVacancy({
    source: KIND,
    externalId: d.externalId,
    url,
    title,
    company: COMPANY,
    descriptionText: description,
    salaryFrom: from,
    salaryTo: to,
    currency,
    area,
    workFormat,
  });
}

export const client: ATSClientImpl = {
  kind: KIND,
  verified: true,
  notes:
    "no public JSON API; list via GET /ajax/vacancy/?page=<n> with header " +
    "X-Requested-With: XMLHttpRequest (else 404; server-rendered HTML fragment, 12 cards/page, " +
    "'Показать ещё' link gives the next page number, absence means done - 22 jobs/2 pages " +
    "on 2026-09); detail via GET /vacancies/{slug}/ (server-rendered: title, salary text or " +
    "'По договоренности', experience/location/employment-type key-value list, full description HTML). " +
    "Apply is a classic Bitrix multi-field HTML POST (name, phone, resume file) with a CSRF sessid, no " +
    "public apply API found -> agent flow only",
  jobsUrl: () => `${LIST_API}?page=1`,
  detect,
  listJobs,
  fetchJob,
};
