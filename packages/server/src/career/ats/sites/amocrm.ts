// amoCRM careers site (amocrm.ru/jobs/), a server-rendered WordPress site (X-Redirect-By: WordPress).
// No public JSON API. /jobs/ renders every open role as a flat, unpaginated list (verified live
// 2026-09: 6/6 jobs across "Производство"/"Техническая поддержка"/xteam categories - the site has no
// pagination controls and no more categories than what's linked from the nav). Each card links to a
// detail page whose <div class="content-block__main"> holds the full plain-ish HTML description (no
// JSON-LD, no structured salary/location - office city is only mentioned in prose). Apply is an
// embedded amoforms iframe (forms.amocrm.ru) with no public JSON API -> apply() omitted, agent flow.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://www.amocrm.ru";
const COMPANY = "amoCRM";
const LIST_URL = `${ORIGIN}/jobs/`;

const CARD_RE = /<a href="([^"]+)" class="jobs__item_link">/gi;
const CATEGORY_RE = /<h3 class="jobs__item_category">([\s\S]*?)<\/h3>/i;
const NAME_RE = /<div class="jobs__item_name">([\s\S]*?)<\/div>/i;
const DESCRIPTION_RE = /<div class="content-block__main">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/i;
const TITLE_RE = /<h1 class="jobs__title[^"]*">([\s\S]*?)<\/h1>/i;

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (host === "amocrm.ru" || host === "www.amocrm.ru") return { token: ORIGIN };
  return /amocrm\.ru\/jobs\//i.test(html) ? { token: ORIGIN } : null;
}

const idFromPath = (path: string): string => path.replace(/^\/+|\/+$/g, "").split("/").pop() ?? path;

// Each card is a run of text between one job link <a> and the next (or end of list) - same
// "split on the repeating start marker" approach as avito.ts/vkusvill.ts, robust to markup drift.
function parseList(html: string): Discovered[] {
  const starts = [...html.matchAll(CARD_RE)];
  const out: Discovered[] = [];
  for (let i = 0; i < starts.length; i++) {
    const href = starts[i]?.[1];
    const from = starts[i]?.index ?? 0;
    const to = starts[i + 1]?.index ?? html.length;
    if (!href) continue;
    // card markup is <article>...category/name...</article><a class="jobs__item_link">: the link
    // trails its own card's text, so look backward from the link to the previous article boundary.
    const cardStart = html.lastIndexOf('<article class="jobs__item">', from);
    const block = html.slice(cardStart >= 0 ? cardStart : from, to);
    const title = stripHtml(decodeEntities(NAME_RE.exec(block)?.[1] ?? "")).trim();
    const category = stripHtml(decodeEntities(CATEGORY_RE.exec(block)?.[1] ?? "")).trim();
    if (!title) continue;
    const url = new URL(href, ORIGIN).toString();
    out.push({
      externalId: atsId("site:amocrm", idFromPath(href)),
      url,
      title,
      company: COMPANY,
      location: category || undefined,
    });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/jobs/`);
  return parseList(html);
}

function descriptionOf(html: string): string {
  return stripHtml(decodeEntities(DESCRIPTION_RE.exec(html)?.[1] ?? ""));
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(TITLE_RE.exec(html)?.[1] ?? "")).trim() || d.title;
  return makeVacancy({
    source: "site:amocrm",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
    area: d.location ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:amocrm",
  verified: true,
  notes:
    "no public JSON API; /jobs/ renders every open role as one flat unpaginated list (6/6 jobs, no pagination controls); " +
    "detail pages have no JSON-LD, description scraped from the plain content-block__main HTML (no structured salary/location, " +
    "office city only appears in prose). Apply is an embedded amoforms.amocrm.ru iframe with no public JSON API -> agent flow.",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
