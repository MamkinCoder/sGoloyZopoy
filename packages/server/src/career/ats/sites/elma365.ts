// ELMA365 careers site (elma365.com/ru/company/careers/ — the base_url elma365.com/ru/career/ 404s),
// a server-rendered Nuxt 2 app. No public JSON API; every page embeds its Nuxt state as
// `window.__NUXT__=(function(a,b,...){return {...}}(<args>))`. That IIFE is plain data (an object
// literal closing over positional args, no external calls), so we evaluate it in a locked-down vm
// context to recover the real object deterministically, same approach as sites/astrum-entertainment.ts.
// Listing lives at data[0].careersByCategories[].careers[] (id/name/format/experience/slug/cities,
// no salary); job detail lives at data[0].career (adds requirements/responsibilities/conditions HTML
// + category). Verified live 2026-09: 6 open vacancies across 2 categories (Продажи, Бэк-офис) — none
// currently a software-dev role, but listJobs returns everything unfiltered per the runner contract.
// No apply API found; the vacancy page's "Откликнуться" is a client-rendered form -> agent flow only.
import vm from "node:vm";
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, originOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://elma365.com";
const LIST_PATH = "/ru/company/careers/";
const COMPANY = "ELMA365";

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:elma365" is itself two
// colon-segments, so we peel our own known prefix instead (same fix as sites/astrum-entertainment.ts).
const KIND_PREFIX = "site:elma365:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

const NUXT_RE = /window\.__NUXT__\s*=\s*(\(function\([\s\S]*?\)\);?)\s*<\/script>/;

interface CityRef {
  cities_id?: { id?: number; city?: string };
}
interface CareerListItem {
  id: number;
  name?: string;
  format?: string;
  experience?: string;
  slug: string;
  cities?: CityRef[];
}
interface CareerCategory {
  id: number;
  name?: string;
  count?: number;
  careers?: CareerListItem[];
}
interface ListingData {
  careersByCategories?: CareerCategory[];
}
interface CareerDetail extends CareerListItem {
  requirements?: string;
  responsibilities?: string;
  conditions?: string;
  category?: { name?: string };
}
interface DetailData {
  career?: CareerDetail;
}

/** Evaluate a page's `window.__NUXT__` IIFE as inert data via node:vm (not regex, not raw eval). */
function readNuxtData<T>(html: string): T | null {
  const src = NUXT_RE.exec(html)?.[1];
  if (!src) return null;
  try {
    const nuxt = vm.runInNewContext(src, Object.create(null), { timeout: 1000 }) as { data?: unknown[] };
    return (nuxt.data?.[0] as T) ?? null;
  } catch {
    return null;
  }
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "elma365.com") return { token: originOf(baseUrl) || ORIGIN };
  return /elma365\.com\/ru\/company\/careers/i.test(html) ? { token: ORIGIN } : null;
}

const areaOf = (cities?: CityRef[]): string =>
  [...new Set((cities ?? []).map((c) => c.cities_id?.city).filter((c): c is string => Boolean(c)))].join(", ");

const workFormatOf = (format?: string): string =>
  format === "office" ? "офис" : format === "hybrid" ? "гибрид" : format === "remote" ? "удалёнка" : (format ?? "");

const toDiscovered = (origin: string, c: CareerListItem): Discovered => ({
  externalId: atsId("site:elma365", c.slug),
  url: `${origin}${LIST_PATH}${c.slug}/`,
  title: (c.name ?? "").trim(),
  company: COMPANY,
  location: areaOf(c.cities) || undefined,
  raw: c,
});

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}${LIST_PATH}`);
  const data = readNuxtData<ListingData>(html);
  const categories = data?.careersByCategories ?? [];
  const out: Discovered[] = [];
  for (const cat of categories) {
    for (const c of cat.careers ?? []) {
      if (!c.name || !c.slug) continue;
      out.push(toDiscovered(origin, c));
    }
  }
  return out;
}

function descriptionOf(v: CareerDetail): string {
  const section = (title: string, html?: string) => (html ? `${title}:\n${stripHtml(html)}` : "");
  return [section("Обязанности", v.responsibilities), section("Требования", v.requirements), section("Условия", v.conditions)]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(origin: string, d: Discovered) {
  const slug = localId(d.externalId);
  const url = `${origin}${LIST_PATH}${slug}/`;
  const html = await getText(url);
  const data = readNuxtData<DetailData>(html);
  const v = data?.career;
  return makeVacancy({
    source: "site:elma365",
    externalId: d.externalId,
    url,
    title: v?.name?.trim() || d.title,
    company: COMPANY,
    descriptionText: v ? descriptionOf(v) : "",
    area: areaOf(v?.cities) || d.location || "",
    workFormat: workFormatOf(v?.format),
  });
}

export const client: ATSClientImpl = {
  kind: "site:elma365",
  verified: true,
  notes:
    "base_url elma365.com/ru/career/ 404s; real listing is elma365.com/ru/company/careers/. No public JSON " +
    "API; list and detail read from window.__NUXT__ embedded in server-rendered HTML at /ru/company/careers/ " +
    "and /ru/company/careers/{slug}/ (evaluated as inert data via node:vm, not regex/raw eval), all jobs on " +
    "one unpaginated page. Listing has format/experience/cities, no salary; detail adds requirements/" +
    "responsibilities/conditions HTML, still no salary field anywhere. 6 open vacancies live 2026-09 (Продажи " +
    "x5, Бэк-офис x1), no dev roles currently but listJobs returns all categories unfiltered. No apply API " +
    "found; vacancy page's respond button is client-rendered -> agent flow only, apply() omitted.",
  jobsUrl: (origin) => `${origin}${LIST_PATH}`,
  detect,
  listJobs,
  fetchJob,
};
