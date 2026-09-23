// Itransition careers site (itransition.com/careers), a Gatsby site (server-rendered HTML, no
// client-side data fetch: view-source already has every job link/title/city, confirmed live 2026-09).
// Listing: GET /careers/vacancies -> one unpaginated page, each job an
//   <a class="vacancy-link" href="/careers/<slug>"><h5 class="vacancy-link-title">...</h5>
//     <div class="vacancy-link-cities"><span class="vacancy-tag-city">...</span>...</div></a>
// Detail: GET /careers/<slug> -> a schema.org JobPosting JSON-LD script (title, description,
// employmentType, jobLocation; no salary field exposed). Apply is a client-rendered form/modal with
// no public JSON API found -> apply() omitted, agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy, toISO } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://www.itransition.com";
const COMPANY = "Itransition";
const LIST_URL = `${ORIGIN}/careers/vacancies`;

// Non-job pages that live under /careers/ alongside vacancy slugs (seen in the site's own sitemap).
const NON_JOB_SLUGS = new Set(["about", "benefits", "career-path", "training", "uz", "vacancies"]);

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "www.itransition.com" || hostOf(baseUrl) === "itransition.com") return { token: ORIGIN };
  return /itransition\.com\/careers\//i.test(html) ? { token: ORIGIN } : null;
}

const CARD_RE = /<a class="vacancy-link" href="(\/careers\/([a-z0-9-]+))">([\s\S]*?)<\/a>/g;
const TITLE_RE = /<h5 class="vacancy-link-title">([^<]*)<\/h5>/i;
const CITY_RE = /<span class="vacancy-tag-city">([^<]*)<\/span>/g;

function parseListing(html: string): Discovered[] {
  const seen = new Set<string>();
  const out: Discovered[] = [];
  for (const m of html.matchAll(CARD_RE)) {
    const [, href, slug, body] = m;
    if (!href || !slug || NON_JOB_SLUGS.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const title = stripHtml(decodeEntities(TITLE_RE.exec(body ?? "")?.[1] ?? "")).trim();
    if (!title) continue;
    const cities = [...(body ?? "").matchAll(CITY_RE)].map((c) => stripHtml(decodeEntities(c[1] ?? "")).trim()).filter(Boolean);
    out.push({
      externalId: atsId("site:itransition", slug),
      url: `${ORIGIN}${href}`,
      title,
      company: COMPANY,
      location: cities.length ? cities.join(", ") : undefined,
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/careers/vacancies`);
  return parseListing(html);
}

interface JobPostingLD {
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  jobLocation?: unknown;
}

function parseJobPosting(html: string): JobPostingLD | null {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1] ?? "") as { "@type"?: string };
      if (data["@type"] === "JobPosting") return data as JobPostingLD;
    } catch {
      // not JSON / not this block
    }
  }
  return null;
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const ld = parseJobPosting(html);
  return makeVacancy({
    source: "site:itransition",
    externalId: d.externalId,
    url: d.url,
    title: ld?.title ?? d.title,
    company: COMPANY,
    descriptionText: ld?.description ? stripHtml(decodeEntities(ld.description)) : "",
    area: d.location ?? "",
    workFormat: ld?.employmentType ?? "",
    publishedAt: toISO(ld?.datePosted),
  });
}

export const client: ATSClientImpl = {
  kind: "site:itransition",
  verified: true,
  notes:
    "no public JSON API needed; Gatsby site but fully server-rendered, GET /careers/vacancies is one " +
    "unpaginated page listing every open role (title + cities) as plain <a class=\"vacancy-link\"> cards; " +
    "detail pages at /careers/<slug> carry a JobPosting JSON-LD (title/description/employmentType/datePosted, " +
    "no salary field). Apply is a client-rendered form with no public JSON API found -> agent flow.",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
