// IT_ONE careers site (www.it-one.ru/vacancies/, verified live 2026-09). Server-rendered Bitrix
// site whose own listing page reads a public JSON endpoint (used to populate a form autocomplete):
//   GET /api/entities/vacancy/ -> Vacancy[] {id, url, name, number, position, city, preview,
//                                             specialization}
// No pagination observed (all ~20 open jobs come back in one array, matching the rendered listing
// count). The listing payload has no full description, so fetchJob scrapes the server-rendered
// detail page at the item's own `url`: <h1> for title, `.article.card .content .body` for the
// description (Обязанности/Требования sections as plain <p>/<h3>), and `.tags` for a Расположение/
// тип работы/Опыт работы tag group (no salary ever shown). Apply is an in-page HTML form posted to
// /send.php or /send-resume.php with an email-confirmation-code step (agreement checkboxes, file
// upload) - no public JSON apply API -> agent flow only, no apply().
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getJson, getText, hostOf, originOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const COMPANY = "IT_ONE";
const KIND = "site:it-one";

const listApi = (origin: string): string => `${origin}/api/entities/vacancy/`;

interface ITOneVacancy {
  id: string;
  url: string; // path, e.g. /vacancies/<hash>/
  name: string;
  number: string;
  position: string; // seniority label
  city: string;
  preview: string;
  specialization: string;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  const origin = originOf(baseUrl);
  if (!origin) return null;
  if (hostOf(baseUrl) === "www.it-one.ru") return { token: origin };
  return /it-one\.ru\/(career|vacancies)/i.test(html) ? { token: origin } : null;
}

const toDiscovered = (origin: string, v: ITOneVacancy): Discovered => ({
  externalId: atsId(KIND, v.id),
  url: new URL(v.url, origin).toString(),
  title: v.name,
  company: COMPANY,
  location: v.city || undefined,
  raw: v,
});

async function listJobs(origin: string): Promise<Discovered[]> {
  const vacancies = await getJson<ITOneVacancy[]>(listApi(origin));
  return vacancies.map((v) => toDiscovered(origin, v));
}

const H1_RE = /<h1>([\s\S]*?)<\/h1>/i;
const BODY_RE = /<section class="article card">[\s\S]*?<div class="body">([\s\S]*?)<\/div>\s*<div class="tags">/i;
const TAG_GROUP_RE = /<div class="group">([\s\S]*?<\/div>)\s*<\/div>\s*<\/div>/g;
const GROUP_LABEL_RE = /<h3>([^<]*)<\/h3>/;
const TAG_RE = /<div class="tag">([^<]*)<\/div>/g;

function tagGroups(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const tagsSection = /<div class="tags">([\s\S]*?)<\/section>/i.exec(html)?.[1] ?? "";
  for (const m of tagsSection.matchAll(TAG_GROUP_RE)) {
    const block = m[1] ?? "";
    const label = decodeEntities(GROUP_LABEL_RE.exec(block)?.[1] ?? "").trim();
    const values = [...block.matchAll(TAG_RE)].map((t) => decodeEntities(t[1] ?? "").trim()).filter(Boolean);
    if (label && values.length) out.set(label, values);
  }
  return out;
}

async function fetchJob(_origin: string, d: Discovered) {
  const cached = d.raw as ITOneVacancy | undefined;
  const html = await getText(d.url);
  const title = stripHtml(decodeEntities(H1_RE.exec(html)?.[1] ?? "")) || cached?.name || d.title;
  const descriptionText = stripHtml(BODY_RE.exec(html)?.[1] ?? "");
  const tags = tagGroups(html);
  const area = tags.get("Расположение")?.join(", ") ?? cached?.city ?? d.location ?? "";
  const workFormat = tags.get("тип работы")?.join(", ") ?? cached?.specialization ?? "";
  return makeVacancy({
    source: KIND,
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText,
    area,
    workFormat,
  });
}

export const client: ATSClientImpl = {
  kind: KIND,
  verified: true,
  notes:
    "list via GET /api/entities/vacancy/ (public JSON feeding the site's own form autocomplete, " +
    "no pagination - all open jobs in one array); detail scraped from the server-rendered " +
    "/vacancies/<hash>/ page (.article.card .body for description, .tags for Расположение/тип " +
    "работы/Опыт работы; no salary ever shown). Apply is an in-page HTML form (name/email/phone/" +
    "resume file, agreement checkboxes) posted to /send.php or /send-resume.php with an email " +
    "confirmation-code step - no public JSON apply API -> agent flow only, no apply().",
  jobsUrl: (origin) => listApi(origin),
  detect,
  listJobs,
  fetchJob,
};
