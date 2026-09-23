// Bitrix24 / 1C-Bitrix careers site. www.1c-bitrix.ru/company/vacancies/ (the given base_url) 404s;
// the site's own header links to careers.bitrix24.ru, its actual careers microsite - built on Bitrix's
// own "Landing" page-builder product (server-rendered, no client fetch, no JSON API, ironically the
// company that makes the CMS doesn't expose one). /jobs/ lists open categories (customer-service,
// development, marketing, other, sales-n-partners), each a static, unpaginated page of job cards
// (icon+href via data-pseudo-url, immediately followed by an <h5> title - verified live 2026-09).
// Detail pages have no JSON-LD; description is plain server-rendered text bounded between the
// "Кто нам нужен?" heading and the "Больше вакансий" footer teaser, both fixed boilerplate on every
// vacancy page. No salary ever published; work format/city is loose prose ("удалённая работа или
// офис в Москве/Калининграде"), not structured, so area/workFormat are left blank rather than guessed.
// Apply is a Bitrix24 CRM webform (script tag data-b24-form="click/82/...") opening an embedded form
// with no public JSON submit API found -> apply() omitted, agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://careers.bitrix24.ru";
const COMPANY = "Bitrix24 / 1C-Bitrix";
const JOBS_URL = `${ORIGIN}/jobs/`;

const CATEGORY_RE = /careers\.bitrix24\.ru\/jobs\/([a-z0-9-]+)\/&quot;/g;
const CARD_RE =
  /data-pseudo-url="\{[^}]*&quot;href&quot;:&quot;([^&]*)&quot;[^}]*\}"><\/i>\s*<\/div>\s*<h5[^>]*>([^<]+)<\/h5>/g;
const HERO_TITLE_RE = /landing-block-node-text landing-semantic-text-image-medium[^>]*>([^<]+)<\/div>/;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "careers.bitrix24.ru") return { token: ORIGIN };
  return /careers\.bitrix24\.ru\/jobs\//i.test(html) ? { token: ORIGIN } : null;
}

function idFromUrl(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  return segs.slice(-2).join("/"); // "<category>/<slug>"
}

function parseCategories(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(CATEGORY_RE)) if (m[1]) out.add(m[1]);
  return [...out];
}

function parseCategoryCards(html: string, origin: string): Discovered[] {
  const out = new Map<string, Discovered>();
  for (const m of html.matchAll(CARD_RE)) {
    const href = decodeEntities(m[1] ?? "");
    const title = stripHtml(decodeEntities(m[2] ?? "")).trim();
    if (!href || !title) continue;
    let url: string;
    try {
      url = new URL(href, origin).toString();
    } catch {
      continue;
    }
    const id = idFromUrl(url);
    out.set(id, { externalId: atsId("site:bitrix24-1c-bitrix", id), url, title, company: COMPANY });
  }
  return [...out.values()];
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const root = await getText(`${origin}/jobs/`);
  const categories = parseCategories(root);
  const seen = new Map<string, Discovered>();
  for (const cat of categories) {
    const html = await getText(`${origin}/jobs/${cat}/`);
    for (const d of parseCategoryCards(html, origin)) seen.set(d.externalId, d);
  }
  return [...seen.values()];
}

// Description is bounded between the fixed "Кто нам нужен?" section heading and the fixed
// "Больше вакансий" footer teaser that appear on every vacancy page (verified live 2026-09).
function descriptionOf(html: string): string {
  const start = html.indexOf("Кто нам нужен?");
  const end = html.indexOf("Больше вакансий");
  if (start < 0 || end < 0 || end <= start) return "";
  return stripHtml(html.slice(start, end));
}

async function fetchJob(origin: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(HERO_TITLE_RE.exec(html)?.[1] ?? "")).trim() || d.title;
  return makeVacancy({
    source: "site:bitrix24-1c-bitrix",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
  });
}

export const client: ATSClientImpl = {
  kind: "site:bitrix24-1c-bitrix",
  verified: true,
  notes:
    "www.1c-bitrix.ru/company/vacancies/ 404s; real careers site is careers.bitrix24.ru, built on Bitrix's " +
    "own Landing page-builder (server-rendered, no JSON API). GET /jobs/ discovers open category slugs " +
    "(customer-service/development/marketing/other/sales-n-partners), GET /jobs/<category>/ lists that " +
    "category's cards (static, unpaginated). Detail page description is plain text bounded between the " +
    "fixed 'Кто нам нужен?' heading and 'Больше вакансий' footer teaser; no salary ever published, " +
    "location/work-format is loose prose so left blank. Apply opens an embedded Bitrix24 CRM webform " +
    "(data-b24-form script), no public submit API found -> agent flow only.",
  jobsUrl: () => JOBS_URL,
  detect,
  listJobs,
  fetchJob,
};
