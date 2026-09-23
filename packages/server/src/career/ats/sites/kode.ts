// KODE careers site (kode.ru/career -> career.kode.ru, a Gatsby SPA). No content in the server-
// rendered HTML (client-only routes via reach-router's matchPath); all vacancy data comes from a
// Strapi v3 GraphQL API at strapi.kode.ru/graphql with introspection enabled and no auth. Verified
// live 2026-09:
//   POST /graphql  { vacancies(where:{status:"publish"}, limit:-1) { id title excerpt body slug
//                     status hot department{name} regions{name} conditions{name} levels{name} } }
// `status` is an ENUM_VACANCIES_STATUS ("publish" | "draft"); only "publish" rows are the company's
// currently open vacancies - confirmed by matching the 5 "publish" rows against the 5 vacancies
// Gatsby actually embeds in the built index page's page-data.json. "draft" covers ~80 old/closed
// postings still in the CMS. `body` is Markdown (Strapi's markdown editor), not HTML, so it's
// cleaned with a small markdown-to-text pass rather than stripHtml. No salary field exists anywhere.
// Detail pages have no server-rendered content and no per-vacancy page-data.json (client-only
// route), so fetchJob re-queries GraphQL by slug instead of scraping HTML.
// Apply is a client-rendered form on the vacancy page (name, phone, email, resume file or link) -
// no public apply API found -> agent flow only, apply() omitted.
import type { Discovered } from "@sgz/shared";
import { hostOf, postJson } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://career.kode.ru";
const GRAPHQL_URL = "https://strapi.kode.ru/graphql";
const COMPANY = "KODE";

interface KodeLabel {
  name: string;
}

interface KodeVacancy {
  id: string;
  title: string;
  excerpt: string;
  body: string;
  slug: string;
  status: "publish" | "draft";
  hot: boolean;
  department: KodeLabel | null;
  regions: KodeLabel[];
  conditions: KodeLabel[];
  levels: KodeLabel[];
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function graphql<T>(query: string): Promise<T> {
  const res = await postJson<GraphQLResponse<T>>(GRAPHQL_URL, { query });
  if (res.errors?.length) throw new Error(`kode graphql error: ${res.errors.map((e) => e.message).join("; ")}`);
  if (!res.data) throw new Error("kode graphql: empty response");
  return res.data;
}

const LIST_QUERY = `{ vacancies(where:{status:"publish"}, limit:-1) {
  id title excerpt slug hot department{name} regions{name} conditions{name} levels{name}
} }`;

const detailQuery = (slug: string) => `{ vacancies(where:{slug:"${slug}"}, limit:1) {
  id title excerpt body slug status hot department{name} regions{name} conditions{name} levels{name}
} }`;

function detect(baseUrl: string, html: string): { token: string } | null {
  const host = hostOf(baseUrl);
  if (host === "career.kode.ru" || host === "kode.ru") return { token: ORIGIN };
  return /career\.kode\.ru/i.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (slug: string): string => `${ORIGIN}/vacancy/${slug}`;

const areaOf = (v: Pick<KodeVacancy, "regions">): string => v.regions.map((r) => r.name).join(", ");
const workFormatOf = (v: Pick<KodeVacancy, "conditions">): string => v.conditions.map((c) => c.name).join(", ");

const toDiscovered = (v: KodeVacancy): Discovered => ({
  externalId: atsId("site:kode", v.slug),
  url: vacancyUrl(v.slug),
  title: v.title,
  company: COMPANY,
  location: areaOf(v) || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const data = await graphql<{ vacancies: KodeVacancy[] }>(LIST_QUERY);
  return data.vacancies.map(toDiscovered);
}

// `body` is Markdown: strip heading/list/emphasis markers and blockquote markers, keep the text.
function markdownToText(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*]\s+/gm, "- ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// externalId is "site:kode:<slug>" (two colon-separated segments); the shared rawId() helper only
// strips one, so the slug is taken from the URL's last path segment instead (same approach as the
// other sites/*.ts clients whose id isn't a single trailing segment).
function slugOf(d: Discovered): string {
  const path = new URL(d.url).pathname;
  return path.slice(path.lastIndexOf("/") + 1);
}

async function fetchJob(_token: string, d: Discovered) {
  const slug = slugOf(d);
  const data = await graphql<{ vacancies: KodeVacancy[] }>(detailQuery(slug));
  const v = data.vacancies[0] ?? (d.raw as KodeVacancy | undefined);
  if (!v) throw new Error(`kode: vacancy not found for slug ${slug}`);
  const levels = v.levels.map((l) => l.name).join(", ");
  const description = [v.excerpt, markdownToText(v.body ?? ""), levels && `Уровень: ${levels}`].filter(Boolean).join("\n\n");
  return makeVacancy({
    source: "site:kode",
    externalId: d.externalId,
    url: vacancyUrl(v.slug),
    title: v.title,
    company: COMPANY,
    descriptionText: description,
    area: areaOf(v) || d.location || "",
    workFormat: workFormatOf(v),
  });
}

export const client: ATSClientImpl = {
  kind: "site:kode",
  verified: true,
  notes:
    "no public REST docs; strapi.kode.ru/graphql (Strapi v3, introspection on, no auth) is the site's own data API - " +
    "vacancies(where:{status:\"publish\"}) is the open/current set (confirmed against the live site's build data), " +
    "\"draft\" rows are old/closed postings kept in the CMS; body field is Markdown; no salary field exists; " +
    "apply is a client-rendered form on the vacancy page (name, phone, email, resume file or link) with no public API -> agent flow only",
  jobsUrl: () => GRAPHQL_URL,
  detect,
  listJobs,
  fetchJob,
};
