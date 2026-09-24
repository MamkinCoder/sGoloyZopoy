// Naumen careers site (www.naumen.ru/career/vacancies/, NOT a career.naumen.ru subdomain - that
// host doesn't resolve). Server-rendered Bitrix site (naumen_job_v2 template), no public JSON API.
// The listing page is a single unpaginated page of <a class="vcnc-item"> cards (verified 2026-09:
// only 4 open vacancies, pagination component present but empty). Job detail pages have no JSON-LD;
// description is split across three fixed-order sections (about/tasks/requirements), each a
// `<div class="vcnc-descr">` under the section's `<section class="vcnc-*">`. No salary in any
// payload observed (mentioned in prose only, not structured). Apply is an ajax popup form
// (POST /ajax/resume.php?ref=<id>) with no documented public JSON schema -> agent flow, apply()
// omitted.
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://www.naumen.ru";
const COMPANY = "Naumen";

const ITEM_RE = /<a href="(\/career\/vacancies\/[a-z0-9_-]+\/)" class="vcnc-item"[\s\S]*?<\/a>/gi;
const CTG_RE = /<div class="vcnc-ctg">\s*<span>([\s\S]*?)<\/span>/i;
const NAME_RE = /<div class="vcnc-name">\s*<span>([\s\S]*?)<\/span>/i;
const TITLE_RE = /<div class="vcnc-title">([\s\S]*?)<\/div>/i;
const PLACE_RE = /<div class="vcnc-place">([\s\S]*?)<\/div>/i;
const PLACE_SPAN_RE = /<span>([\s\S]*?)<\/span>/g;

const text = (s: string | undefined): string => stripHtml(decodeEntities(s ?? "")).trim();

function parseListing(html: string): Discovered[] {
  const out: Discovered[] = [];
  for (const m of html.matchAll(ITEM_RE)) {
    const block = m[0];
    const path = m[1];
    const title = text(TITLE_RE.exec(block)?.[1]);
    if (!path || !title) continue;
    const placeBlock = PLACE_RE.exec(block)?.[1] ?? "";
    const places = [...placeBlock.matchAll(PLACE_SPAN_RE)].map((p) => text(p[1])).filter(Boolean);
    const id = path.replace(/^\/career\/vacancies\//, "").replace(/\/$/, "");
    out.push({
      externalId: atsId("site:naumen", id),
      url: new URL(path, ORIGIN).toString(),
      title,
      company: COMPANY,
      location: places[0] || undefined,
      raw: { category: text(CTG_RE.exec(block)?.[1]), team: text(NAME_RE.exec(block)?.[1]), places },
    });
  }
  return out;
}

function detect(baseUrl: string, html: string): { token: string } | null {
  return hostOf(baseUrl) === "www.naumen.ru" || /naumen\.ru\/career\/vacancies/.test(html) ? { token: ORIGIN } : null;
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}/career/vacancies/`);
  return parseListing(html);
}

const SECTION_RE = (cls: string) => new RegExp(`<section class="${cls}">[\\s\\S]*?<div class="vcnc-descr">([\\s\\S]*?)</div>\\s*</div>\\s*</section>`, "i");
const ABOUT_RE = SECTION_RE("vcnc-product-about");
const TASKS_RE = SECTION_RE("vcnc-tasks-about");
const REQS_RE = SECTION_RE("vcnc-requirements-about");

function descriptionOf(html: string): string {
  const section = (label: string, re: RegExp) => {
    const body = text(re.exec(html)?.[1]);
    return body ? `${label}\n${body}` : "";
  };
  return [text(ABOUT_RE.exec(html)?.[1]), section("Задачи", TASKS_RE), section("Требования", REQS_RE)].filter(Boolean).join("\n\n");
}

async function fetchJob(_origin: string, d: Discovered) {
  const html = await getText(d.url);
  const h1 = text(/<h1 class="hero__title">([\s\S]*?)<\/h1>/i.exec(html)?.[1]);
  const placeBlock = /<div class="vcnc-place">([\s\S]*?)<\/div>/i.exec(html)?.[1] ?? "";
  const places = [...placeBlock.matchAll(PLACE_SPAN_RE)].map((p) => text(p[1])).filter(Boolean);
  return makeVacancy({
    source: "site:naumen",
    externalId: d.externalId,
    url: d.url,
    title: h1 || d.title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
    area: places[0] || d.location || "",
    workFormat: places.slice(1).join(", "),
  });
}

export const client: ATSClientImpl = {
  kind: "site:naumen",
  verified: true,
  notes:
    "server-rendered Bitrix (naumen_job_v2 template), no public JSON API; listing at /career/vacancies/ is a single " +
    "unpaginated page (4 open vacancies on 2026-09-23); detail description is 3 fixed sections (about/tasks/requirements), " +
    "no salary field anywhere; apply is an ajax popup form (POST /ajax/resume.php?ref=<id>), no documented JSON schema -> agent flow only",
  jobsUrl: (origin) => `${origin}/career/vacancies/`,
  detect,
  listJobs,
  fetchJob,
};
