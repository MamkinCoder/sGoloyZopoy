// IVI careers site (corp.ivi.ru), a WordPress site with a custom vacancies theme, server-rendered.
// www.ivi.ru/pages/jobs (the nominal base_url) 404s; the real listing is linked from the ivi.ru
// homepage footer as corp.ivi.ru/career/, which 301s to corp.ivi.ru/vacancies/. That page shows
// only the first 5 jobs per category with a "Показать все (N)" link to the full per-category page
// at /vacancies/<slug>/ (slugs seen live: it-product, business, contact-center); those pages render
// every job in the category unpaginated, no query params needed. No JSON API: /wp-json/wp/v2/vacancy
// 404s (the custom post type isn't REST-exposed). Job detail pages (/vacancy/<slug>/) have no
// JSON-LD; content is plain HTML blocks (h3.vacancy__block-title + div.vacancy__block-content),
// skipping the trailing benefits list. No structured salary/area/workFormat fields are published;
// office location (Moscow) appears only as free text inside benefits, so area/workFormat are left
// blank. Apply is a Contact Form 7 POST (name, email, optional message, required resume file) gated
// by a hidden reCAPTCHA token field -> no public apply API, agent flow only. Verified live 2026-09.
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, originOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://corp.ivi.ru";
const LISTING_URL = `${ORIGIN}/vacancies/`;

const SECTION_LINK_RE = /<a href="(https:\/\/corp\.ivi\.ru\/vacancies\/[a-z-]+\/)" class="vacancies__btn btn_show">/gi;
const ITEM_RE =
  /<a href="(https:\/\/corp\.ivi\.ru\/vacancy\/[a-z0-9-]+\/)" class="vacancies-list__item-link">([\s\S]*?)<\/a>/gi;
const NAME_RE = /<div class="vacancies-list__item-name">([\s\S]*?)<\/div>/i;
const EXTRA_RE = /<div class="vacancies-list__item-extra">([^<]*)<\/div>/i;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "corp.ivi.ru") return { token: ORIGIN };
  return /corp\.ivi\.ru\/vacanc/i.test(html) ? { token: ORIGIN } : null;
}

function idFromUrl(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? url;
}

function parseSectionSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const m of html.matchAll(SECTION_LINK_RE)) if (m[1]) slugs.add(m[1]);
  return [...slugs];
}

function parseSectionItems(html: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const url = m[1];
    const block = m[2] ?? "";
    const title = stripHtml(NAME_RE.exec(block)?.[1] ?? "").trim();
    const level = stripHtml(EXTRA_RE.exec(block)?.[1] ?? "").trim();
    if (!url || !title) continue;
    out.push({ externalId: atsId("site:ivi", idFromUrl(url)), url, title, company: "IVI", raw: { level } });
  }
  return out;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const root = await getText(`${origin}/vacancies/`);
  const seen = new Map<string, Discovered>();
  for (const d of parseSectionItems(root)) seen.set(d.externalId, d);
  for (const sectionUrl of parseSectionSlugs(root)) {
    const html = await getText(sectionUrl);
    for (const d of parseSectionItems(html)) seen.set(d.externalId, d);
  }
  return [...seen.values()];
}

const BLOCK_RE = /<h3 class="vacancy__block-title">([\s\S]*?)<\/h3>\s*<div class="vacancy__block-content">([\s\S]*?)<\/div>\s*<\/div>/gi;
const TITLE_H2_RE = /<h2 class="vacancy__title">([\s\S]*?)<\/h2>/i;
const SUBTITLE_RE = /<div class="vacancy__subtitle">([\s\S]*?)<\/div>/i;

function descriptionOf(html: string, level: string): string {
  const parts: string[] = [];
  const subtitle = stripHtml(SUBTITLE_RE.exec(html)?.[1] ?? "").trim();
  if (subtitle) parts.push(subtitle);
  if (level) parts.push(`Уровень: ${level}`);
  for (const m of html.matchAll(BLOCK_RE)) {
    const heading = stripHtml(m[1] ?? "").trim();
    // "Команда больших возможностей" is the benefits/perks list, not part of the job itself.
    if (heading === "Команда больших возможностей") continue;
    const body = stripHtml(m[2] ?? "").trim();
    if (!heading || !body) continue;
    parts.push(`${heading}\n${body}`);
  }
  return parts.join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as { level?: string } | undefined;
  const html = await getText(d.url);
  const title = stripHtml(TITLE_H2_RE.exec(html)?.[1] ?? "").trim() || d.title;
  return makeVacancy({
    source: "site:ivi",
    externalId: d.externalId,
    url: d.url,
    title,
    company: "IVI",
    descriptionText: descriptionOf(html, cached?.level ?? ""),
  });
}

export const client: ATSClientImpl = {
  kind: "site:ivi",
  verified: true,
  notes:
    "server-rendered WordPress site, no JSON API (/wp-json/wp/v2/vacancy 404s); " +
    "/vacancies/ discovers category section slugs (it-product, business, contact-center) via the " +
    "'Показать все' links, each /vacancies/<slug>/ page lists every job in that category unpaginated; " +
    "job detail has no JSON-LD, description built from vacancy__block sections (benefits block skipped); " +
    "no structured salary/area/workFormat fields published; a seniority tag (Junior/Middle/Senior/Head) " +
    "from the listing card is folded into descriptionText as 'Уровень: ...'; " +
    "apply is a Contact Form 7 POST (name, email, message, resume file) behind a hidden reCAPTCHA token -> agent flow only",
  jobsUrl: () => LISTING_URL,
  detect,
  listJobs,
  fetchJob,
};
