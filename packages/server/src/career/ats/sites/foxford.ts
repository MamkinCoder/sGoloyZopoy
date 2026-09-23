// Foxford (jobs.foxford.ru) careers site. base_url https://foxford.ru/about/career is behind a
// QRATOR JS auth challenge (401 + a __qrator/qauth_*.js script, no plain-HTTP bypass found), but it
// links out to the real, unprotected careers site at jobs.foxford.ru - a server-rendered Astro/
// Webflow-style page with no public JSON API. Verified live 2026-09.
//   GET https://jobs.foxford.ru/vacancies        -> full listing, all 34 open jobs on one
//                                                    unpaginated page (client-side direction/level
//                                                    filters are just data attributes on the same
//                                                    markup, ?direction=N returns the identical HTML).
//                                                    Each job is an <a class="vcn__item"> card with
//                                                    <p class="vcn__point-text"> chips (direction,
//                                                    location(s), a stray "₽" referral-bonus icon)
//                                                    and a level chip, plus <h3 class="vcn__name">.
//   GET https://jobs.foxford.ru/vacancies/{slug}  -> detail page; labeled
//                                                    <div class="cms-vacancy__point-title">Формат
//                                                    работы|Уровень|Зарплата|...</div> chips next to
//                                                    <p class="cms-vacancy__point-text"> values, and
//                                                    the full description as
//                                                    <div class="vcn-cms-vacancy__description
//                                                    w-richtext">. Salary is free text ("до 450 000 ₽
//                                                    (gross)", "от 105 000 ₽ (net)") when published;
//                                                    most vacancies have none.
// Apply is an inline client-rendered form (name, phone, email, resume upload) on the same page, no
// login or captcha seen, no public JSON submit API found -> agent flow only, apply() omitted.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://jobs.foxford.ru";
const LIST_URL = `${ORIGIN}/vacancies`;
const COMPANY = "Foxford";

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "jobs.foxford.ru") return { token: ORIGIN };
  return /jobs\.foxford\.ru\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

// Each card is <a href="/vacancies/{slug}" class="vcn__item"><div class="vcn__points">...chips...
// </div><h3 class="vcn__name">Title</h3><svg data-type="arrow" ...>; splitting up to the arrow svg
// keeps the match small and avoids swallowing the next card.
const CARD_RE = /<a data-css="arrow-rotated" href="(\/vacancies\/[a-z0-9-]+)" class="vcn__item">([\s\S]*?)<svg data-type="arrow"/g;
const POINT_RE = /class="vcn__point-text[^"]*">([^<]+)</g;
const LEVELS = new Set(["intern", "junior", "middle", "senior", "lead", "любой"]);

function parseListing(html: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of html.matchAll(CARD_RE)) {
    const path = m[1];
    const body = m[2] ?? "";
    if (!path) continue;
    const title = stripHtml(decodeEntities(/<h3 class="vcn__name">([^<]*)<\/h3>/.exec(body)?.[1] ?? ""));
    if (!title) continue;
    const points = [...body.matchAll(POINT_RE)].map((p) => decodeEntities(p[1] ?? "").trim()).filter((p) => p && p !== "₽");
    // points[0] is the direction (category, not location); everything after it that isn't a level
    // keyword is a work-format/location chip.
    const location = points.slice(1).filter((p) => !LEVELS.has(p.toLowerCase())).join(", ");
    const url = new URL(path, ORIGIN).toString();
    const slug = path.split("/").pop() ?? path;
    out.push({ externalId: atsId("site:foxford", slug), url, title, company: COMPANY, location: location || undefined });
  }
  return out;
}

async function listJobs(): Promise<Discovered[]> {
  return parseListing(await getText(LIST_URL));
}

const TITLE_RE = /<h1 data-archive="title"[^>]*>([\s\S]*?)<\/h1>/;
const POINT_BLOCK_RE = /<div class="cms-vacancy__point-title">([^<]*)<\/div>([\s\S]*?)<\/div>(?=<div class="cms-vacancy__point"|<\/div><div class="vcn-cms-vacancy__description)/g;
const DESCRIPTION_RE = /vcn-cms-vacancy__description w-richtext">([\s\S]*?)<\/div><div class="vcn-cms-vacancy__btns-wrap"/;

// "до 450 000 ₽ (gross)" | "от 105 000 ₽ (net)" | "" (unset)
function parseSalary(text: string): { salaryFrom: number; salaryTo: number; currency: string } {
  const nums = [...text.matchAll(/[\d\s]{4,}/g)].map((m) => Number(m[0].replace(/\s/g, ""))).filter((n) => n > 0);
  if (nums.length === 0) return { salaryFrom: 0, salaryTo: 0, currency: "" };
  const isFrom = /^\s*от\s/i.test(text);
  const value = nums[0] ?? 0;
  return { salaryFrom: isFrom ? value : 0, salaryTo: isFrom ? 0 : value, currency: "RUR" };
}

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(TITLE_RE.exec(html)?.[1] ?? "")) || d.title;

  const points = new Map<string, string>();
  for (const m of html.matchAll(POINT_BLOCK_RE)) {
    const label = decodeEntities(m[1] ?? "").trim();
    const value = stripHtml(decodeEntities(m[2] ?? "")).replace(/\s+/g, " ").trim();
    if (label) points.set(label, value);
  }

  const { salaryFrom, salaryTo, currency } = parseSalary(points.get("Зарплата") ?? "");
  const descriptionText = stripHtml(decodeEntities(DESCRIPTION_RE.exec(html)?.[1] ?? ""));

  return makeVacancy({
    source: "site:foxford",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText,
    area: points.get("Формат работы") ?? d.location ?? "",
    workFormat: points.get("Занятость") ?? "",
    salaryFrom,
    salaryTo,
    currency,
  });
}

export const client: ATSClientImpl = {
  kind: "site:foxford",
  verified: true,
  notes:
    "base_url foxford.ru/about/career is behind a QRATOR JS auth challenge (401, no plain-HTTP bypass); " +
    "the real careers site is the unprotected jobs.foxford.ru, server-rendered, no public JSON API. " +
    "GET /vacancies lists all 34 open jobs (2026-09) on one unpaginated page (direction/level filters " +
    "are client-side only); GET /vacancies/{slug} gives labeled point chips (Формат работы/Уровень/" +
    "Зарплата/Занятость/...) plus the full description div. Salary is free text when published (most " +
    "vacancies have none), parsed with a regex, RUB assumed. Apply is an inline client-rendered form " +
    "(name, phone, email, resume upload) on the same page, no login/captcha, no public submit API " +
    "found -> agent flow only, apply() omitted.",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
