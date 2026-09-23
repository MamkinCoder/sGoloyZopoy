// Magnit Tech careers site (magnit.tech), a Vite/React SPA whose own root page IS the vacancies
// listing (no separate /career/ path - that 404s). Public JSON API confirmed live 2026-09:
//   GET /api/v1/vacancy?per_page=100        -> paginated list (56 total, fits in one page)
//   GET /api/v1/vacancy/{id}                -> detail: description/tasks/skills/extra_skills/offer
//                                               (all HTML fragments), location, work_formats. No
//                                               salary field is ever present.
// Frontend route for a job is /vacancies/{id} using the same `id` (not `foreign_id`).
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getJson, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://magnit.tech";
const LIST_API = `${ORIGIN}/api/v1/vacancy`;
const COMPANY = "Magnit Tech";
const PER_PAGE = 100;

interface MagnitListItem {
  id: number;
  title: string;
  location: string | null;
}

interface MagnitVacancy {
  id: number;
  title: string;
  description?: string | null;
  about_product?: string | null;
  tasks?: string | null;
  skills?: string | null;
  extra_skills?: string | null;
  offer?: string | null;
  location?: string | null;
  work_formats?: { name: string }[];
}

function detect(baseUrl: string): { token: string } | null {
  return hostOf(baseUrl) === "magnit.tech" ? { token: ORIGIN } : null;
}

const toDiscovered = (v: MagnitListItem): Discovered => ({
  externalId: atsId("site:magnit-tech", v.id),
  url: `${ORIGIN}/vacancies/${v.id}`,
  title: v.title,
  company: COMPANY,
  location: v.location || undefined,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const page = await getJson<{ results: MagnitListItem[]; meta: { total: number } }>(`${LIST_API}?per_page=${PER_PAGE}`);
  return (page.results ?? []).map(toDiscovered);
}

function htmlField(html: string | null | undefined): string {
  return html ? stripHtml(decodeEntities(html)) : "";
}

function descriptionOf(v: MagnitVacancy): string {
  const section = (title: string, html?: string | null) => {
    const text = htmlField(html);
    return text ? `${title}:\n${text}` : "";
  };
  return [
    htmlField(v.description),
    section("Задачи", v.tasks),
    section("Требования", v.skills),
    section("Будет плюсом", v.extra_skills),
    section("Условия", v.offer),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const workFormatOf = (v: MagnitVacancy): string => v.work_formats?.map((f) => f.name).join(", ") ?? "";

async function fetchJob(_token: string, d: Discovered) {
  const res = await getJson<{ results: MagnitVacancy }>(`${LIST_API}/${rawIdOf(d.externalId)}`);
  const v = res.results;
  return makeVacancy({
    source: "site:magnit-tech",
    externalId: d.externalId,
    url: d.url,
    title: v.title ?? d.title,
    company: COMPANY,
    descriptionText: descriptionOf(v),
    area: v.location || d.location || "",
    workFormat: workFormatOf(v),
  });
}

// "site:magnit-tech:2886" -> "2886"
const rawIdOf = (externalId: string): string => externalId.slice(externalId.lastIndexOf(":") + 1);

export const client: ATSClientImpl = {
  kind: "site:magnit-tech",
  verified: true,
  notes:
    "no dedicated /career/ path - magnit.tech's own root is the SPA vacancies listing; public JSON API " +
    "GET /api/v1/vacancy?per_page=100 (56 total, one page) and GET /api/v1/vacancy/{id} for detail " +
    "(description/tasks/skills/extra_skills/offer as HTML fragments, location, work_formats, no salary " +
    "field ever present); apply is POST /api/v1/applicant-response (form fields incl. resume upload) " +
    "-> agent flow, no login seen on the listing/detail pages, no captcha observed on GET.",
  jobsUrl: () => `${LIST_API}?per_page=${PER_PAGE}`,
  detect,
  listJobs,
  fetchJob,
};
