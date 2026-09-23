// Security Code careers site (securitycode.ru/company/career/ -> redirects to /company/hr/), a
// server-rendered Bitrix page. The "Вакансии" widget on /company/hr/ is filled client-side by
// `$('.result').load('all.php')` (relative to /company/hr/), which returns the full unfiltered,
// unpaginated list as plain HTML fragments - no JSON API, no pagination (verified live 2026-09,
// 2 open jobs). Each job is a <p class="common-text small link"> with the title anchor and three
// <span> (employment type, city, experience level). Detail pages are server-rendered HTML with the
// full description as inner HTML of <div id="hr_detail"> - no JSON-LD, no salary ever shown; city
// only appears on the list page, so fetchJob falls back to the Discovered.location carried over.
// Apply is email-only (mailto:jobs@example.com, no form) -> nothing to automate, no apply().
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, originOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://www.securitycode.ru";
const HR_PATH = "/company/hr/";
const LIST_URL = `${ORIGIN}${HR_PATH}all.php`;
const COMPANY = "Security Code";

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (host === "securitycode.ru" || host === "www.securitycode.ru") {
    if (new URL(baseUrl).pathname.startsWith("/company/") || /company\/hr/i.test(html)) return { token: ORIGIN };
  }
  return /securitycode\.ru\/company\/hr/i.test(html) ? { token: originOf(baseUrl) || ORIGIN } : null;
}

// Each job is one <p class="common-text small link"> block: title anchor, then employment/city/
// experience <span>s. Split on the opening <p> so a malformed block can't swallow its neighbours.
const JOB_BLOCK_RE = /<p class="common-text small link">([\s\S]*?)<\/p>/g;
const TITLE_RE = /<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
const SPAN_RE = /<span>([\s\S]*?)<\/span>/g;

function parseJob(block: string, origin: string): Discovered | null {
  const link = TITLE_RE.exec(block);
  if (!link) return null;
  const url = new URL(link[1] ?? "", origin).toString();
  const title = stripHtml(decodeEntities(link[2] ?? "")).trim();
  if (!title) return null;
  const spans = [...block.matchAll(SPAN_RE)].map((m) => stripHtml(decodeEntities(m[1] ?? "")).trim());
  const city = spans[1] || undefined;
  const slug = url.replace(/\/+$/, "").split("/").pop() ?? url;
  return { externalId: atsId("site:security-code", slug), url, title, company: COMPANY, location: city };
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(LIST_URL.replace(ORIGIN, origin));
  const out: Discovered[] = [];
  for (const m of html.matchAll(JOB_BLOCK_RE)) {
    const job = parseJob(m[1] ?? "", origin);
    if (job) out.push(job);
  }
  return out;
}

const DETAIL_RE = /<div id="hr_detail">([\s\S]*?)<\/div>\s*(?:<!--|<\/div>)/i;
const TITLE_H_RE = /<p class="common-title hr">([\s\S]*?)<\/p>/i;

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const descriptionText = stripHtml(decodeEntities(DETAIL_RE.exec(html)?.[1] ?? ""));
  const title = stripHtml(decodeEntities(TITLE_H_RE.exec(html)?.[1] ?? "")) || d.title;
  return makeVacancy({
    source: "site:security-code",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText,
    area: d.location ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:security-code",
  verified: true,
  notes:
    "no public JSON API; list is GET /company/hr/all.php (plain HTML fragment the page normally loads via " +
    "jQuery .load(), full unpaginated set); detail description is the inner HTML of <div id=\"hr_detail\"> on " +
    "the job's own server-rendered page (no JSON-LD, no salary ever shown); city only appears on the list page " +
    "so it's carried over from Discovered.location; apply is email-only (mailto:jobs@example.com), no form " +
    "to automate",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
