// VkusVill careers site (vkusvill.ru/job/), a server-rendered Bitrix site (job.vkusvill.ru redirects
// to the plain vkusvill.ru homepage - dead subdomain, ignore it). No public JSON API. /job/retail/ and
// /job/courier/ are location/search-form pages with no flat job list; /job/office/ is the one category
// that renders every open office/IT role as a static, unpaginated list (page itself says "N вакансий",
// matching the link count - verified live 2026-09, 10/10). Each card links to a detail page at
// /job/vacancys/<slug>_<id>.html, which embeds a full schema.org JobPosting as JSON-LD (plain-ish
// description, city, salary maxPrice when published). Apply is a client-rendered modal form
// (js-vacancy-form) with no public JSON API found -> apply() omitted, agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy, toISO } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://vkusvill.ru";
const COMPANY = "VkusVill";
const OFFICE_LIST_URL = `${ORIGIN}/job/office/`;

const CARD_START_RE = /<a href="(\/job\/vacancys\/[a-z0-9_-]+\.html)" class="[^"]*js-job-office-vacancy[^"]*">/gi;
const NAME_RE = /Role__Item_Name[^>]*>([\s\S]*?)<\/div>/i;
const CITY_RE = /<div class="_city">[\s\S]*?<div>([^<]*)<\/div>/i;
const ID_RE = /_(\d+)\.html$/;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "vkusvill.ru" && /\/job\b/.test(new URL(baseUrl).pathname)) return { token: ORIGIN };
  return /vkusvill\.ru\/job\/vacancys\//i.test(html) ? { token: ORIGIN } : null;
}

const idFromPath = (path: string): string => ID_RE.exec(path)?.[1] ?? path;

// Each card is a run of text between one office-vacancy <a> and the next (or end of the list),
// same "split on the repeating start marker" approach as avito.ts - robust to markup drift.
function parseOfficeList(html: string): Discovered[] {
  const starts = [...html.matchAll(CARD_START_RE)];
  const out: Discovered[] = [];
  for (let i = 0; i < starts.length; i++) {
    const href = starts[i]?.[1];
    const from = starts[i]?.index ?? 0;
    const to = starts[i + 1]?.index ?? html.length;
    if (!href) continue;
    const block = html.slice(from, to);
    const id = idFromPath(href);
    const title = stripHtml(decodeEntities(NAME_RE.exec(block)?.[1] ?? "")).trim();
    const city = stripHtml(decodeEntities(CITY_RE.exec(block)?.[1] ?? "")).trim();
    if (!title) continue;
    out.push({
      externalId: atsId("site:vkusvill", id),
      url: new URL(href, ORIGIN).toString(),
      title,
      company: COMPANY,
      location: city || undefined,
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/job/office/`);
  return parseOfficeList(html);
}

interface JobPostingLD {
  title?: string;
  description?: string;
  datePosted?: string;
  baseSalary?: { maxPrice?: number };
  jobLocation?: { address?: { addressLocality?: string } };
}

function parseJobPosting(html: string): JobPostingLD | null {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1] ?? "") as { "@type"?: string };
      if (data["@type"] === "JobPosting") return data as JobPostingLD;
    } catch {
      // not JSON / not this block (page also carries a BreadcrumbList block)
    }
  }
  return null;
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const ld = parseJobPosting(html);
  return makeVacancy({
    source: "site:vkusvill",
    externalId: d.externalId,
    url: d.url,
    title: ld?.title ?? d.title,
    company: COMPANY,
    descriptionText: ld?.description ? stripHtml(decodeEntities(ld.description)) : "",
    area: ld?.jobLocation?.address?.addressLocality ?? d.location ?? "",
    salaryFrom: ld?.baseSalary?.maxPrice ?? 0,
    publishedAt: toISO(ld?.datePosted),
  });
}

export const client: ATSClientImpl = {
  kind: "site:vkusvill",
  verified: true,
  notes:
    "no public JSON API; job.vkusvill.ru is a dead redirect to the homepage, real careers site is vkusvill.ru/job/; " +
    "/job/office/ is the one category rendered as a full unpaginated list (page's own 'N вакансий' count matches the link count); " +
    "detail pages carry a JobPosting JSON-LD (description/city/salary maxPrice, no employmentType). " +
    "Apply is a client-rendered modal form (js-vacancy-form) with no public JSON API found -> agent flow.",
  jobsUrl: () => OFFICE_LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
