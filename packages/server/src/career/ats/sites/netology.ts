// Netology careers site (netology.ru/job), a Next.js Pages Router app with no public JSON API.
// Both the list page (/job) and every detail page (/job/<id>) are server-rendered and embed the full
// jobs state in the classic `<script id="__NEXT_DATA__">` blob: list page has
// props.pageProps.initialState.jobs.jobsList (vacancies grouped by department), detail page has
// .jobContent (same shape, single vacancy). No salary field exists anywhere. Confirmed live 2026-09
// (11 open vacancies, all EdTech/ops roles - none dev, but listJobs returns everything unfiltered).
import type { Discovered } from "@sgz/shared";
import { getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://netology.ru";
const COMPANY = "Netology";
const LIST_URL = `${ORIGIN}/job`;

// rawId() from types.ts strips one "[a-z_]+:" segment, but our kind "site:netology" is itself two
// colon-segments, so we peel our own known prefix instead (same issue as sites/megafon.ts).
const KIND_PREFIX = "site:netology:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

interface NetologySection {
  title?: string;
  description?: string;
}

interface NetologyVacancy {
  id: string;
  title: string;
  jobType?: string;
  location?: string;
  sections?: NetologySection[];
  isPublished?: boolean;
  qualification?: string[];
  department?: string;
}

interface NetologyJobsState {
  jobsList?: { department?: string; vacancies?: NetologyVacancy[] }[];
  jobContent?: NetologyVacancy;
}

const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

function parseJobsState(html: string): NetologyJobsState | null {
  const m = NEXT_DATA_RE.exec(html);
  if (!m?.[1]) return null;
  try {
    const data = JSON.parse(m[1]) as { props?: { pageProps?: { initialState?: { jobs?: NetologyJobsState } } } };
    return data.props?.pageProps?.initialState?.jobs ?? null;
  } catch {
    return null;
  }
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "netology.ru") return { token: ORIGIN };
  return /netology\.ru\/job\b/.test(html) ? { token: ORIGIN } : null;
}

const vacancyUrl = (origin: string, id: string): string => `${origin}/job/${id}`;

const toDiscovered = (origin: string, v: NetologyVacancy): Discovered => ({
  externalId: atsId("site:netology", v.id),
  url: vacancyUrl(origin, v.id),
  title: v.title,
  company: COMPANY,
  location: v.location || undefined,
  raw: v,
});

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/job`);
  const state = parseJobsState(html);
  const out: Discovered[] = [];
  for (const group of state?.jobsList ?? []) {
    for (const v of group.vacancies ?? []) {
      if (v.isPublished === false) continue;
      out.push(toDiscovered(origin, v));
    }
  }
  return out;
}

const JOB_TYPE_RU: Record<string, string> = { full_time: "Полная занятость", part_time: "Частичная занятость" };

function descriptionOf(v: NetologyVacancy): string {
  const parts = (v.sections ?? []).map((s) => {
    const title = (s.title ?? "").trim();
    const body = stripHtml(s.description ?? "");
    return title ? `${title}\n${body}` : body;
  });
  const qual = v.qualification?.length ? `Уровень: ${v.qualification.join(", ")}` : "";
  return [...parts, qual].filter(Boolean).join("\n\n");
}

async function fetchJob(origin: string, d: Discovered) {
  const html = await getText(vacancyUrl(origin, localId(d.externalId)));
  const state = parseJobsState(html);
  const v = state?.jobContent;
  const cached = d.raw as NetologyVacancy | undefined;
  const source = v ?? cached;
  if (!source) {
    return makeVacancy({ source: "site:netology", externalId: d.externalId, url: d.url, title: d.title, company: COMPANY });
  }
  return makeVacancy({
    source: "site:netology",
    externalId: d.externalId,
    url: d.url,
    title: source.title || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(source),
    area: source.location || d.location || "",
    workFormat: JOB_TYPE_RU[source.jobType ?? ""] ?? source.jobType ?? "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:netology",
  verified: true,
  notes:
    "no public JSON API; /job (list) and /job/<id> (detail) are server-rendered Next.js pages embedding the " +
    "full vacancy data in the classic __NEXT_DATA__ script tag (props.pageProps.initialState.jobs.jobsList / " +
    ".jobContent) - no salary field ever present. Apply is an on-page form (name, resume link or file upload) " +
    "posting to an internal API with no documented public endpoint, no login required -> agent flow only.",
  jobsUrl: () => LIST_URL,
  detect,
  listJobs,
  fetchJob,
};
