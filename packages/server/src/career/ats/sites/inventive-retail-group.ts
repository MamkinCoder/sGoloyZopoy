// Inventive Retail Group careers site (job.inventive.ru, a WordPress site — irgroup.ru, the base_url
// given for this integration, is a parked/for-sale domain and unrelated). Verified live 2026-09.
// WordPress exposes the "vacancy" custom post type on its public REST API:
//   GET /wp-json/wp/v2/vacancy?per_page=100&page=N  -> {id, slug, link, title.rendered, content.rendered}
//   paginated via X-WP-Total / X-WP-TotalPages headers, no auth needed.
// content.rendered is the full plain-ish HTML job description (no salary field on this site at all).
// City and work format aren't in the REST payload, so fetchJob scrapes them from the server-rendered
// detail page: the single "single-vacancy--address" div (city) and the "...item_info--tags-item" spans
// (city/office/district/format tags; format detected by matching known keywords).
// Apply is a Contact Form 7 POST (name/phone/email/brand/city/vacancy/employment-type/story/resume file)
// behind reCAPTCHA v3 — no public JSON apply API, so apply() is omitted → agent flow.
import type { Discovered } from "@sgz/shared";
import { getJson, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://job.inventive.ru";
const API = `${ORIGIN}/wp-json/wp/v2/vacancy`;
const PAGE_SIZE = 100;
const COMPANY = "Inventive Retail Group";

const FORMAT_RE = /Полная занятость|Частичная занятость|Удаленная работа|Временная работа|Стажировка|^\d\/\d$/i;

interface WPVacancy {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "job.inventive.ru") return { token: ORIGIN };
  return /job\.inventive\.ru\/wp-json\/wp\/v2\/vacancy/.test(html) ? { token: ORIGIN } : null;
}

const toDiscovered = (v: WPVacancy): Discovered => ({
  externalId: atsId("site:inventive-retail-group", v.id),
  url: v.link,
  title: stripHtml(v.title.rendered),
  company: COMPANY,
  raw: v,
});

// WP's REST pagination 400s (rest_post_invalid_page_number) once `page` exceeds the total page
// count instead of returning an empty array, so a full-sized last page needs a follow-up request
// that we expect to fail — that's the loop's normal exit, not an error.
async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (let page = 1; ; page++) {
    let items: WPVacancy[];
    try {
      items = await getJson<WPVacancy[]>(`${API}?per_page=${PAGE_SIZE}&page=${page}`);
    } catch {
      break;
    }
    out.push(...items.map(toDiscovered));
    if (items.length < PAGE_SIZE) break;
  }
  return out;
}

const ADDRESS_RE = /<div class="single-vacancy--address">([\s\S]*?)<\/div>/i;
const TAG_RE = /<div class="vacancies-block--item_info--tags-item"><span>([^<]*)<\/span><\/div>/g;

function areaAndFormat(html: string): { area: string; workFormat: string } {
  const area = stripHtml(ADDRESS_RE.exec(html)?.[1] ?? "");
  const tags = [...html.matchAll(TAG_RE)].map((m) => (m[1] ?? "").trim());
  const workFormat = tags.find((t) => FORMAT_RE.test(t)) ?? "";
  return { area, workFormat };
}

async function fetchJob(_token: string, d: Discovered) {
  const cached = d.raw as WPVacancy | undefined;
  const html = await getText(d.url);
  const { area, workFormat } = areaAndFormat(html);
  return makeVacancy({
    source: "site:inventive-retail-group",
    externalId: d.externalId,
    url: d.url,
    title: cached ? stripHtml(cached.title.rendered) : d.title,
    company: COMPANY,
    descriptionText: stripHtml(cached?.content.rendered ?? ""),
    area,
    workFormat,
  });
}

export const client: ATSClientImpl = {
  kind: "site:inventive-retail-group",
  verified: true,
  notes:
    "WordPress: list via public GET /wp-json/wp/v2/vacancy?per_page&page (id/title/content.rendered/link, " +
    "X-WP-Total paginated, no salary field anywhere on the site); city + work format scraped from the " +
    "server-rendered detail page (single-vacancy--address div, item_info--tags-item spans). " +
    "Apply is a Contact Form 7 POST (name/phone/email/brand/city/vacancy/employment-type/story/resume file) " +
    "behind reCAPTCHA v3, no public JSON apply API → agent flow.",
  jobsUrl: () => `${API}?per_page=${PAGE_SIZE}&page=1`,
  detect,
  listJobs,
  fetchJob,
};
