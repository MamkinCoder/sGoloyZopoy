// AGIMA (agima.ru) digital agency careers site, a server-rendered Bitrix page (no SPA bundle, no
// XHR API). Verified live 2026-09: base_url given as /vacancies/ 404s, the real list lives at
// GET /careers/ - a plain GET with every open vacancy inline, no pagination.
//   GET /careers/                          -> HTML; each job is a
//                                              <div class="careers-jobs__vacancy js-item"
//                                                   data-category="{design|administration|
//                                                   management|internship|development}">
//                                              with an <a href="/careers/vacancy/{slug}/">{title}</a>.
//                                              data-category is AGIMA's own tab filter (design/admin/
//                                              management/internship/development); not a location, so
//                                              it's dropped here - the runner's own keyword filter
//                                              decides relevance from the full job description instead.
//   GET /careers/vacancy/{slug}/           -> HTML; <h1> is the real per-job title (the page <title>
//                                              is a generic "Работа в AGIMA" for every vacancy). Body
//                                              is a sequence of <div class="vacancy__post"><h3>{heading}
//                                              </h3><div class="vacancy__post-list">{list html}</div></div>
//                                              blocks ("Что предстоит делать" / "Что нам важно" /
//                                              "Будет плюсом" / "Что предлагаем" / ...), joined here
//                                              into one description. No structured salary or city field
//                                              anywhere (office is implied Moscow in the benefits text).
// Apply is a client-rendered form (#vacancyApllication: NAME/EMAIL/PHONE/MESSAGE + file upload) with
// no public JSON apply API -> agent flow only, apply() omitted.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://www.agima.ru";
const LIST_URL = `${ORIGIN}/careers/`;
const COMPANY = "AGIMA";

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "www.agima.ru" || hostOf(baseUrl) === "agima.ru") return { token: ORIGIN };
  return /agima\.ru\/careers\//i.test(html) ? { token: ORIGIN } : null;
}

// Each open vacancy is one <a href="/careers/vacancy/{slug}/">{title}</a> inside the
// #vacancies list; the wrapping <div class="careers-jobs__vacancy js-item"> only carries a
// data-category tab filter around it, so matching the anchor directly is enough.
const LINK_RE = /<a href="(\/careers\/vacancy\/[a-z0-9_-]+\/)">([\s\S]*?)<\/a>/g;

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(LIST_URL);
  const out: Discovered[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(LINK_RE)) {
    const url = new URL(m[1] ?? "", ORIGIN).toString();
    const title = stripHtml(decodeEntities(m[2] ?? ""));
    if (!title || seen.has(url)) continue;
    seen.add(url);
    const slug = url.replace(/\/$/, "").split("/").pop() ?? url;
    out.push({ externalId: atsId("site:agima", slug), url, title, company: COMPANY });
  }
  return out;
}

const H1_RE = /<h1>([\s\S]*?)<\/h1>/;
const POST_RE = /<div class="vacancy__post-name">\s*<h3>([\s\S]*?)<\/h3>\s*<\/div>\s*<div class="vacancy__post-list">([\s\S]*?)<\/div>\s*<\/div>/g;

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(H1_RE.exec(html)?.[1] ?? "")) || d.title;
  const sections = [...html.matchAll(POST_RE)]
    .map((m) => `${stripHtml(decodeEntities(m[1] ?? ""))}\n${stripHtml(decodeEntities(m[2] ?? ""))}`)
    .join("\n\n");
  return makeVacancy({
    source: "site:agima",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText: sections,
  });
}

export const client: ATSClientImpl = {
  kind: "site:agima",
  verified: true,
  notes:
    "no public JSON API; list is the full server-rendered GET /careers/ HTML (all open jobs, no " +
    "pagination, 6 live 2026-09: design/administration/management/internship/development); detail " +
    "sections (Что предстоит делать/Что нам важно/Будет плюсом/Что предлагаем/...) scraped from " +
    "GET /careers/vacancy/{slug}/ vacancy__post blocks; the real title is the page <h1> (the <title> " +
    "tag is a generic constant for every vacancy); no structured salary or city field anywhere. " +
    "Apply is a client-rendered form (#vacancyApllication: name/email/phone/message + file upload), " +
    "no public apply API -> agent flow only.",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
