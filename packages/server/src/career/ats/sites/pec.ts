// PEC (ПЭК) careers site (verified 2026-09 live against hr.pecom.ru, a Bitrix site; the
// pecom.ru/company/vacancies/ URL in configs 404s - the real site is the hr. subdomain, linked from
// pecom.ru's footer). No public JSON API: the listing page (/vacancies/) is a client-side filter
// widget (`data-app="page-vacancy-all"`) that POSTs {cat,city,area} to /ajax/vacancy.php and swaps in
// a server-rendered HTML fragment of <a href="{slug}/" class="pvavci-title"> job cards. cat=0 returns
// every open vacancy across departments in one unpaginated response (~40 jobs, confirmed live). Job
// detail pages are plain server-rendered HTML at /vacancies/{slug}/ with title in <p class="h1">, city
// in <p class="h3 pv-city">, and Обязанности/Требования/Условия sections as raw <li> siblings (no
// <ul>) inside <div class="pv-vacancy">. No salary anywhere on the site (pay is "discussed with the
// candidate"). Apply is a Bitrix multipart form (name/phone/email, resume file, image captcha) posted
// back to the vacancy URL - no public apply API, agent flow only.
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, httpFetch, originOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const HOST = "hr.pecom.ru";

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === HOST) return { token: originOf(baseUrl) || `https://${HOST}` };
  return /hr\.pecom\.ru\/(vacancies|ajax\/vacancy\.php)/i.test(html) ? { token: `https://${HOST}` } : null;
}

const CARD_RE = /<a\s+href="([a-z0-9-]+)\/"\s+class="pvavci-title">\s*([\s\S]*?)<\/a>/gi;

function parseCards(fragment: string, origin: string): Discovered[] {
  const seen = new Map<string, Discovered>();
  for (const m of fragment.matchAll(CARD_RE)) {
    const slug = m[1];
    const title = stripHtml(m[2] ?? "").trim();
    if (!slug || !title) continue;
    seen.set(slug, { externalId: atsId("site:pec", slug), url: `${origin}/vacancies/${slug}/`, title, company: "PEC" });
  }
  return [...seen.values()];
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const res = await httpFetch(`${origin}/ajax/vacancy.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest" },
    body: "cat=0&city=0&area=0",
  });
  if (!res.ok) throw new Error(`POST ${origin}/ajax/vacancy.php -> HTTP ${res.status}`);
  return parseCards(await res.text(), origin);
}

const H1_RE = /<p class="h1">([\s\S]*?)<\/p>/i;
const CITY_RE = /<p class="h3 pv-city">([\s\S]*?)<\/p>/i;
const BODY_RE = /<div class="inner-style is-style-list pv-vacancy js-pv-vacancy">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="wrapper small">\s*<div class="h3">/i;

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(H1_RE.exec(html)?.[1] ?? "").trim() || d.title;
  const area = stripHtml(CITY_RE.exec(html)?.[1] ?? "").trim();
  const descriptionText = stripHtml(BODY_RE.exec(html)?.[1] ?? "");
  return makeVacancy({
    source: "site:pec",
    externalId: d.externalId,
    url: d.url,
    title,
    company: "PEC",
    descriptionText,
    area,
  });
}

export const client: ATSClientImpl = {
  kind: "site:pec",
  verified: true,
  notes:
    "list via POST /ajax/vacancy.php (form body cat=0&city=0&area=0), an internal filter endpoint returning an " +
    "HTML fragment of all open vacancies unpaginated (~40 jobs, no auth); detail scraped from server-rendered " +
    "/vacancies/{slug}/ HTML (h1 title, h3.pv-city city, Обязанности/Требования/Условия as <li> siblings, no salary " +
    "published anywhere); apply is a Bitrix multipart form (name/phone/email, resume file, image captcha) posted to " +
    "the vacancy URL itself - no public apply API, agent flow only.",
  jobsUrl: (origin) => `${origin}/ajax/vacancy.php`,
  detect,
  listJobs,
  fetchJob,
};
