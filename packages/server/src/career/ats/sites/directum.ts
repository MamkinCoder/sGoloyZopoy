// Directum careers site (www.directum.ru/career redirects to career.directum.ru). Server-rendered
// custom site (not a recognizable off-the-shelf platform), no public JSON API. /vacancy lists every
// direction (section) with its open jobs inline - directions with none render a "no open vacancies"
// placeholder instead of cards, so no pagination and nothing further to fetch (verified 2026-09: 1 open
// vacancy). The ?city= query param is a client-side filter only (confirmed server ignores it), so
// listJobs always reads the unfiltered page. Detail pages have no JSON-LD; description is the run of
// <p>/heading markup between the h1/tags header and the "Почему стоит идти к нам" (benefits) block.
// Apply is a form embedded on the same page (resume file + contact fields, POST target not inspected),
// no login, no captcha observed -> agent flow, apply() omitted.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, originOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://career.directum.ru";
const LIST_URL = `${ORIGIN}/vacancy`;
const COMPANY = "Directum";

const text = (s: string | undefined): string => stripHtml(decodeEntities(s ?? "")).trim();

const ITEM_RE =
  /<div class="vacancy-item__content js-vacancy-item">[\s\S]*?<a href="(\/[a-z0-9_-]+)" class="vacancy-link">([\s\S]*?)<\/a>[\s\S]*?<\/div>\s*<\/div>/gi;
const CITY_RE = /data-city="([^"]*)"/i;
const DIRECTION_RE = /<h4 class="vacancy-list__title js-vacancy-direction">([\s\S]*?)<\/h4>/i;

function parseListing(html: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const path = m[1];
    const title = text(m[2]);
    if (!path || !title) continue;
    const block = m[0];
    const city = text(CITY_RE.exec(block)?.[1]);
    const id = path.replace(/^\//, "");
    out.push({
      externalId: atsId("site:directum", id),
      url: new URL(path, ORIGIN).toString(),
      title,
      company: COMPANY,
      location: city || undefined,
      raw: { direction: text(DIRECTION_RE.exec(html.slice(0, m.index))?.[1] ?? "") },
    });
  }
  return out;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  return hostOf(baseUrl) === "career.directum.ru" || /career\.directum\.ru\/vacancy/.test(html)
    ? { token: ORIGIN }
    : null;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/vacancy`);
  return parseListing(html);
}

const TAGS_RE = /<div class="vacancy__tags">([\s\S]*?)<\/div>\s*<a[^>]*id="scrollToResume"/i;
const TAG_TEXT_RE = /<span class="vacancy__tag-text">([\s\S]*?)<\/span>/g;
const DESCRIPTION_RE =
  /id="scrollToResume"[^>]*>[\s\S]*?<\/a><\/div>\s*<div class="container px-2 px-lg-5">([\s\S]*?)<div class="vacancy__text-title[^>]*><span>Почему стоит идти к нам<\/span>/i;

function workFormatOf(html: string): string {
  const block = TAGS_RE.exec(html)?.[1] ?? "";
  return [...block.matchAll(TAG_TEXT_RE)].map((t) => text(t[1])).filter(Boolean).join(", ");
}

function descriptionOf(html: string): string {
  return text(DESCRIPTION_RE.exec(html)?.[1]);
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const h1 = text(/<h1 class="vacancy__title">([\s\S]*?)<\/h1>/i.exec(html)?.[1]);
  return makeVacancy({
    source: "site:directum",
    externalId: d.externalId,
    url: d.url,
    title: h1 || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
    area: d.location ?? "",
    workFormat: workFormatOf(html),
  });
}

export const client: ATSClientImpl = {
  kind: "site:directum",
  verified: true,
  notes:
    "custom server-rendered site, no public JSON API; listing at /vacancy is a single unpaginated page " +
    "with all directions inline (1 open vacancy on 2026-09-23), ?city= filter is client-side JS only; " +
    "detail description is the plain markup between the header and the benefits block, no salary field " +
    "anywhere; apply is an on-page form (resume file + contact fields), no login/captcha seen -> agent flow only",
  jobsUrl: (origin) => `${origin}/vacancy`,
  detect,
  listJobs,
  fetchJob,
};
