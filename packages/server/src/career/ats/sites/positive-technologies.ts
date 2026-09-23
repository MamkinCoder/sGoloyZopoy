// Positive Technologies careers site (ptsecurity.com/about/vacancy/), a server-rendered Next.js
// App Router page (React Server Components), single unpaginated page: the list's own embedded
// pagination JSON reports pageCount:1 for all 16 open jobs (2026-09), grouped under category <h2>
// headings with <li data-testid="vacancy-card-link"> cards (title, href, "Локация:"/"Продукт:"
// chips). No public JSON API found - the RSC payload does carry the same data as escaped JSON
// inside a JS string literal, but the rendered HTML cards are simpler and more stable to scrape.
// Detail pages are also server-rendered: the job-specific body lives in
// <div data-testid="article-content"> (responsibilities/requirements/etc as plain <p>/<ul>), ending
// right before the generic "Мы предлагаем" perks section that's identical on every vacancy. A
// JobPosting JSON-LD is present but carries no description and no salary (none is ever published),
// so city is carried over from the listing instead. Apply is a client-rendered form on the same
// page (data-testid="vacancy-respond") - no public apply API found, so apply() is omitted.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://ptsecurity.com";
const LIST_URL = `${ORIGIN}/about/vacancy/`;
const COMPANY = "Positive Technologies";

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "ptsecurity.com") return { token: ORIGIN };
  return /ptsecurity\.com\/(ru-ru\/)?about\/vacancy/i.test(html) ? { token: ORIGIN } : null;
}

// Cards are <li class="VacancyPreview_vacancy__..."><a data-testid="vacancy-card-link" href="...">
// </a><div>...<h3>title</h3>...<small>Локация:</small><small>city</small>[<small>Продукт:</small>
// <small>product</small>]</div></li>. Split on the next card start (or end) rather than balancing tags.
const CARD_START_RE = /<li class="VacancyPreview_vacancy__[^"]*">/g;
const LINK_RE = /data-testid="vacancy-card-link" href="([^"]+)"/i;
const TITLE_RE = /<h3[^>]*>([\s\S]*?)<\/h3>/i;
const DETAIL_PAIR_RE = /<small class="VacancyPreview_details-title__[^"]*">([^<]*)<\/small><small class="VacancyPreview_details-value__[^"]*">([^<]*)<\/small>/g;

function parseListing(html: string, origin: string): Discovered[] {
  const starts = [...html.matchAll(CARD_START_RE)];
  const out: Discovered[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]?.index ?? 0;
    const to = starts[i + 1]?.index ?? html.length;
    const block = html.slice(from, to);
    const href = LINK_RE.exec(block)?.[1];
    const title = stripHtml(decodeEntities(TITLE_RE.exec(block)?.[1] ?? "")).trim();
    if (!href || !title) continue;
    let location: string | undefined;
    for (const m of block.matchAll(DETAIL_PAIR_RE)) {
      if (decodeEntities(m[1] ?? "").trim().startsWith("Локация")) location = decodeEntities(m[2] ?? "").trim();
    }
    const url = new URL(href, origin).toString();
    const slug = url.replace(/\/+$/, "").split("/").pop() ?? url;
    out.push({ externalId: atsId("site:positive-technologies", slug), url, title, company: COMPANY, location });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(LIST_URL.replace(ORIGIN, origin));
  return parseListing(html, origin);
}

const ARTICLE_RE = /data-testid="article-content"[^>]*>([\s\S]*?)<\/div><\/div><section>/;

function descriptionOf(html: string): string {
  const block = ARTICLE_RE.exec(html)?.[1] ?? "";
  return stripHtml(decodeEntities(block));
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const h1 = stripHtml(decodeEntities(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ""));
  return makeVacancy({
    source: "site:positive-technologies",
    externalId: d.externalId,
    url: d.url,
    title: h1 || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
    area: d.location ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:positive-technologies",
  verified: true,
  notes:
    "no public JSON API; list is server-rendered GET /about/vacancy/ (unpaginated, pageCount:1 for all " +
    "open jobs); detail description is the inner text of <div data-testid=\"article-content\"> on the job's " +
    "own server-rendered page, up to the generic \"Мы предлагаем\" perks section; JobPosting JSON-LD present " +
    "but carries no description/salary (salary never published) so city is carried over from the listing. " +
    "Apply is a client-rendered form on the same page (data-testid=\"vacancy-respond\"), no public apply " +
    "API found -> agent flow only",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
