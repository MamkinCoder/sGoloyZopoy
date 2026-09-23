// KAMAZ careers site. career.kamaz.ru does not resolve (NXDOMAIN); jobs live under the main
// corporate site at kamaz.ru/career/work/vacancies/, a legacy Bitrix-CMS page, server-rendered,
// no JSON API. The whole vacancy list (196 jobs as of 2026-09-23) is on that one page, grouped by
// plant/department in accordion sections - no pagination. Detail pages at
// /career/work/vacancies/{id}/ have title + salary in <div id="vacName">, full description as
// free-form HTML in <div class="blocks-vacancy"> up to the apply <form name="iblock_add">. No
// per-job city field (KAMAZ's plants are all in Naberezhnye Chelny; the only city dropdown on the
// page is the applicant's own city for the apply form, not the job's location). Salary is a prose
// string ("от N руб. до вычета налогов" / "от N до M руб. ..." / "до N руб. ...").
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://kamaz.ru";
const LIST_PATH = "/career/work/vacancies/";
const COMPANY = "КАМАЗ";

// rawId() strips one "[a-z_]+:" segment; our kind "site:kamaz" is itself two colon-segments, so
// peel our own known prefix instead (same issue as sites/rzd.ts and sites/rostelecom.ts).
const KIND_PREFIX = "site:kamaz:";
const localId = (externalId: string): string => externalId.replace(KIND_PREFIX, "");

const text = (s: string | undefined): string => stripHtml(decodeEntities(s ?? "")).trim();

function detect(baseUrl: string, html: string): { token: string } | null {
  return hostOf(baseUrl) === "kamaz.ru" || /kamaz\.ru\/career\/work\/vacancies\//.test(html)
    ? { token: ORIGIN }
    : null;
}

const ITEM_RE = /<a href="(\/career\/work\/vacancies\/(\d+)\/)" target="_self">([^<]+)<\/a>/gi;

function parseListing(html: string): Discovered[] {
  const out = new Map<string, Discovered>();
  for (const m of html.matchAll(ITEM_RE)) {
    const [, href, id, title] = m;
    if (!href || !id || !title) continue;
    const cleanTitle = text(title);
    if (!cleanTitle) continue;
    out.set(id, {
      externalId: atsId("site:kamaz", id),
      url: new URL(href, ORIGIN).toString(),
      title: cleanTitle,
      company: COMPANY,
    });
  }
  return [...out.values()];
}

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getText(`${origin}${LIST_PATH}`);
  return parseListing(html);
}

const VACNAME_RE = /<div id="vacName">([\s\S]*?)<div class="salary">([\s\S]*?)<\/div>\s*<\/div>/i;
const DETAIL_RE = /<div class="blocks-vacancy">([\s\S]*?)<form name="iblock_add"/i;

/** "от 75000 руб. ...", "от 82000 до 107000 руб. ...", "до 130000 руб. ..." -> [from, to]. */
function parseSalary(raw: string): [number, number] {
  const nums = (raw.match(/\d[\d\s]*\d|\d/g) ?? []).map((n) => Number(n.replace(/\s/g, "")));
  if (nums.length === 0) return [0, 0];
  if (/^\s*до\b/i.test(raw.trim())) return [0, nums[0] ?? 0];
  if (nums.length >= 2) return [nums[0] ?? 0, nums[1] ?? 0];
  return [nums[0] ?? 0, 0];
}

async function fetchJob(origin: string, d: Discovered) {
  const html = await getText(d.url);
  const head = VACNAME_RE.exec(html);
  const title = text(head?.[1]) || d.title;
  const [salaryFrom, salaryTo] = parseSalary(head?.[2] ?? "");
  const descriptionText = text(DETAIL_RE.exec(html)?.[1]);
  return makeVacancy({
    source: "site:kamaz",
    externalId: d.externalId,
    url: d.url,
    title,
    company: COMPANY,
    descriptionText,
    salaryFrom,
    salaryTo,
    currency: salaryFrom || salaryTo ? "RUB" : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:kamaz",
  verified: true,
  notes:
    "career.kamaz.ru does not resolve; jobs are on the main site at kamaz.ru/career/work/vacancies/ " +
    "(legacy Bitrix, server-rendered, no JSON API). Single unpaginated page lists all open jobs grouped " +
    "by plant/department (196 jobs, mostly manufacturing/blue-collar, as of 2026-09-23; listJobs returns " +
    "all unfiltered per contract). Detail page: title+salary in #vacName, free-form HTML description in " +
    ".blocks-vacancy up to the apply form. No per-job city field (plants are all in Naberezhnye Chelny). " +
    "Salary is prose ('от N руб. до вычета налогов' / 'от N до M руб.' / 'до N руб.'), parsed with a regex. " +
    "Apply is a server-rendered multipart form (name/phone/email/city/resume file) posted back to the same " +
    "vacancy URL, no public JSON apply API -> agent flow only, no apply() implemented.",
  jobsUrl: (origin) => `${origin}${LIST_PATH}`,
  detect,
  listJobs,
  fetchJob,
};
