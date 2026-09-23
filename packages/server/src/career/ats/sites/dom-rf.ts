// DOM.RF careers site. Not on career.domrf.ru (NXDOMAIN) - domrf.ru redirects to the IDN main
// site дом.рф (xn--d1aqf.xn--p1ai), a Bitrix site whose /career/vacancies/ page mounts a Vue
// catalog. Verified live 2026-09 (198 open vacancies across the whole group, 10 tagged IT).
//   GET /api/v2/content/career/vacancies/list/?page={n}[&type=it]
//     -> JSON {data:[{id,name,date,external_id,url,props:{intern,it,biz,city,company,department}}],
//        nav:{page-size,page-count,page-number,total}}. page-size is fixed at 6 server-side, so
//        listing everything means looping page=1..nav.page-count.
//   GET /career/vacancy/{id}/ -> HTML; full text is not a separate JSON endpoint, it's embedded
//     server-side in <main id="vacancies-detail" data='{...}'></main> (single-quoted attribute,
//     escaped double-quote JSON inside - safe to cut at the "'></main>" terminator). Parsed JSON's
//     .vacancy has {id,active,external_id,name,detail_text (HTML),props:{intern,it,biz,city,
//     company,department,potok}}. No salary field anywhere (list or detail).
// props.company varies per posting (АО «БАНК ДОМ.РФ» / ПАО ДОМ.РФ / Фонд ДОМ.РФ - group entities),
// so fetchJob/listJobs use it when present and fall back to "ДОМ.РФ" for the group as a whole.
// Apply is a client-rendered form (resume upload) behind Yandex SmartCaptcha (smartcaptcha_key seen
// inline) - no public apply API found -> agent flow only.
import type { Discovered } from "@sgz/shared";
import { getJson, getText, hostOf } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://xn--d1aqf.xn--p1ai";
const LIST_API = `${ORIGIN}/api/v2/content/career/vacancies/list/`;
const GROUP = "ДОМ.РФ";
const MAX_PAGES = 60; // nav.page-count was 33 at 6/page (198 jobs); generous ceiling against growth

interface DomRfProps {
  intern?: string;
  it?: string;
  biz?: string;
  city?: string;
  company?: string;
  department?: string;
}

interface DomRfListItem {
  id: number;
  name: string;
  date?: string;
  external_id: string;
  url: string;
  props?: DomRfProps;
}

interface DomRfListResponse {
  data: DomRfListItem[];
  nav: { "page-size": number; "page-count": number; "page-number": number; total: number };
}

interface DomRfVacancyDetail {
  id: string;
  active?: string;
  external_id: string;
  name: string;
  detail_text?: string;
  props?: DomRfProps;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (host === "xn--d1aqf.xn--p1ai" || host === "дом.рф") return { token: ORIGIN };
  return /xn--d1aqf\.xn--p1ai\/career\/vacanc/i.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (id: number | string): string => `${ORIGIN}/career/vacancy/${id}/`;

const toDiscovered = (v: DomRfListItem): Discovered => ({
  externalId: atsId("site:dom-rf", v.id),
  url: vacancyUrl(v.id),
  title: v.name.trim(),
  company: v.props?.company || GROUP,
  location: v.props?.city || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await getJson<DomRfListResponse>(`${LIST_API}?page=${page}`);
    for (const v of res.data) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(toDiscovered(v));
    }
    if (page >= res.nav["page-count"] || res.data.length === 0) break;
  }
  return out;
}

// Full vacancy JSON is embedded as <main id="vacancies-detail" data='{...}'></main>; the attribute
// is single-quoted while the JSON inside uses only escaped double quotes, so this terminator is safe.
const DETAIL_START = '<main id="vacancies-detail" data=\'';
const DETAIL_END = "'></main>";

function detailOf(html: string): DomRfVacancyDetail | null {
  const start = html.indexOf(DETAIL_START);
  if (start === -1) return null;
  const from = start + DETAIL_START.length;
  const end = html.indexOf(DETAIL_END, from);
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(html.slice(from, end)) as { vacancy?: DomRfVacancyDetail };
    return parsed.vacancy ?? null;
  } catch {
    return null;
  }
}

// detail_text is well-formed HTML from a rich-text editor (p/ul/li/strong/span), already imported
// via getJson-free getText, so strip it with the same stripHtml a plain regex approach would need -
// but its markup is simple enough that a lightweight tag strip suffices without extra deps.
function plainTextOf(html: string): string {
  return html
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&mdash;|&ndash;/gi, "-")
    .replace(/&bull;/gi, "-")
    .replace(/&amp;/gi, "&")
    .replace(/&laquo;/gi, "«")
    .replace(/&raquo;/gi, "»")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const html = await getText(d.url);
  const v = detailOf(html);
  const cached = d.raw as DomRfListItem | undefined;
  const props = v?.props ?? cached?.props;
  return makeVacancy({
    source: "site:dom-rf",
    externalId: d.externalId,
    url: d.url,
    title: (v?.name ?? d.title).trim(),
    company: props?.company || GROUP,
    descriptionText: v?.detail_text ? plainTextOf(v.detail_text) : "",
    area: props?.city || d.location || "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:dom-rf",
  verified: true,
  notes:
    "not on career.domrf.ru (NXDOMAIN) - real site is дом.рф (xn--d1aqf.xn--p1ai) /career/vacancies/; " +
    "list via public JSON GET /api/v2/content/career/vacancies/list/?page={n} (page-size fixed at 6, " +
    "loop to nav.page-count; ?type=it filters to the IT category); detail text is embedded server-side " +
    "as JSON in a data attribute on GET /career/vacancy/{id}/ (<main id=\"vacancies-detail\" data='{...}'>), " +
    "no separate detail API; no salary field ever exposed (list or detail); company varies per posting " +
    "(bank/JSC/fund entities in the group) so it's read from props.company, falling back to the group " +
    "name; apply is a client-rendered form (resume upload) behind Yandex SmartCaptcha, no public apply " +
    "API found -> agent flow only",
  jobsUrl: () => `${LIST_API}?page=1`,
  detect,
  listJobs,
  fetchJob,
};
