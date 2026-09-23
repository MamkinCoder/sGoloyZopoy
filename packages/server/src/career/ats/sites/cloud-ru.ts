// Cloud.ru careers site (cloud.ru/career), a Next.js app router site with real server-side
// rendering. /career/vacancies embeds the full, unpaginated vacancy list (all ~100 open jobs, no
// query params/pagination needed - the on-page "pages" control just paginates client-side over data
// already sent) as a React Server Components flight payload: a <script>self.__next_f.push([1,"..."])
// tag whose string body is line-oriented (`N:<json>`); the line assigning `vacanciesData`/`filters`
// carries `{"vacanciesData":[{id,experience,work_format,unit,position,body,requirements,conditions,
// isClosed}],"filters":[{code:"unit"|"experience"|"work_format",items:[{id,name}]}]}`. List items
// carry no body/requirements/conditions (always "") and no salary/location field - only detail pages
// (GET /career/vacancies/{id}, server-rendered HTML) have the full ОБЯЗАННОСТИ/ТРЕБОВАНИЯ/УСЛОВИЯ
// sections. No city field exists anywhere on the site; work_format (Офис/Удаленно/Гибрид) is the only
// location signal. No salary ever exposed. Verified live 2026-09 (102 open vacancies).
// Apply is a client-rendered "Отправить резюме" button (form fields not inspected) - no public JSON
// apply API found, so apply() is omitted; agent flow only.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://cloud.ru";
const LIST_URL = `${ORIGIN}/career/vacancies`;
const COMPANY = "Cloud.ru";

interface NamedRef {
  id: number;
  name: string;
}

interface CloudRuListItem {
  id: number;
  experience?: NamedRef;
  work_format?: NamedRef;
  unit?: NamedRef;
  position: string;
  isClosed?: boolean;
}

interface FilterGroup {
  code: string;
  items: NamedRef[];
}

interface VacanciesPageProps {
  vacanciesData: CloudRuListItem[];
  filters?: FilterGroup[];
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "cloud.ru" && new URL(baseUrl).pathname.startsWith("/career")) return { token: ORIGIN };
  return /cloud\.ru\/career\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

// The flight payload is a JS string literal (JSON-escaped) inside self.__next_f.push([1,"...","]).
// Find the push() call whose string contains the props we want, JSON-decode the JS string itself,
// then find its "N:<json>" line that starts a React element carrying vacanciesData.
function extractVacanciesProps(html: string): VacanciesPageProps | null {
  const marker = html.indexOf("vacanciesData");
  if (marker === -1) return null;
  const start = html.lastIndexOf("<script>self.__next_f.push([1,", marker);
  const end = html.indexOf("])</script>", marker);
  if (start === -1 || end === -1) return null;
  const call = html.slice(start, end + 2); // include trailing "])"
  const m = /^<script>self\.__next_f\.push\(\[1,(.*)\]\)$/s.exec(call);
  if (!m?.[1]) return null;
  let body: string;
  try {
    body = JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
  for (const line of body.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1 || !line.slice(colon + 1).includes("vacanciesData")) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(colon + 1));
      const props = Array.isArray(parsed) ? (parsed[3] as VacanciesPageProps | undefined) : undefined;
      if (props?.vacanciesData) return props;
    } catch {
      // not this line
    }
  }
  return null;
}

function unitNameLookup(filters: FilterGroup[] | undefined): Map<number, string> {
  const items = filters?.find((f) => f.code === "unit")?.items ?? [];
  return new Map(items.map((i) => [i.id, i.name]));
}

function tagsOf(v: CloudRuListItem, units: Map<number, string>): string {
  const unit = v.unit?.name || units.get(v.unit?.id ?? -1) || "";
  return [unit, v.experience?.name, v.work_format?.name].filter(Boolean).join(" • ");
}

const vacancyUrl = (id: number | string): string => `${LIST_URL}/${id}`;

function toDiscovered(v: CloudRuListItem, units: Map<number, string>): Discovered {
  return {
    externalId: atsId("site:cloud-ru", v.id),
    url: vacancyUrl(v.id),
    title: v.position,
    company: COMPANY,
    location: v.work_format?.name || undefined,
    raw: { tags: tagsOf(v, units) },
  };
}

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(LIST_URL);
  const props = extractVacanciesProps(html);
  if (!props) return [];
  const units = unitNameLookup(props.filters);
  return props.vacanciesData.filter((v) => !v.isClosed).map((v) => toDiscovered(v, units));
}

const H1_RE = /<h1[^>]*class="[^"]*__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i;
const TAGS_RE = /<p[^>]*class="[^"]*__tags[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
const SECTION_RE = /<p[^>]*class="[^"]*__title[^"]*"[^>]*>([^<]*)<\/p>\s*<div[^>]*class="[^"]*__content[^"]*">([\s\S]*?)<\/div>\s*<\/div>/gi;

function descriptionOf(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(SECTION_RE)) {
    const heading = stripHtml(decodeEntities(m[1] ?? "")).trim();
    const content = stripHtml(decodeEntities(m[2] ?? "")).trim();
    if (heading && content) parts.push(`${heading}\n${content}`);
  }
  return parts.join("\n\n");
}

async function fetchJob(_token: string, d: Discovered) {
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(H1_RE.exec(html)?.[1] ?? "")).trim() || d.title;
  const tags = stripHtml(decodeEntities(TAGS_RE.exec(html)?.[1] ?? ""))
    .split("•")
    .map((t) => t.trim())
    .filter(Boolean);
  const workFormat = tags.find((t) => /офис|удал|гибрид/i.test(t)) ?? "";
  return makeVacancy({
    source: "site:cloud-ru",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
    area: "",
    workFormat: workFormat || d.location || "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:cloud-ru",
  verified: true,
  notes:
    "no public JSON API; list is the full unpaginated Next.js RSC flight payload embedded in " +
    "GET /career/vacancies (self.__next_f.push string carrying {vacanciesData,filters}, ~100 open " +
    "jobs on 2026-09); list items have no body/salary/city, only unit/experience/work_format tags " +
    "(unit id resolved via filters[code=unit].items when the item's own unit.name is blank); detail " +
    "is server-rendered HTML at GET /career/vacancies/{id} with ОБЯЗАННОСТИ/ТРЕБОВАНИЯ/УСЛОВИЯ " +
    "sections as the full description, no city field anywhere on the site, no salary ever exposed; " +
    "apply is a client-rendered \"Отправить резюме\" button, no public apply API found -> agent flow only",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
