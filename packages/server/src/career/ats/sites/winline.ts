// Winline careers site (rabota.winline.ru), a server-rendered Bitrix-ish site (main winline.ru has
// no careers section at all - /career, /job, /vacancy etc. all fall back to the betting homepage).
// The listing page (/vacancies) groups jobs into 5 fixed categories (cat_1 IT&TECH, cat_2 Маркетинг,
// cat_3 Бэк-офис, cat_4 Call-центр, cat_5 Спорт-бар) and lazy-loads extra pages per category via a
// public JSON endpoint found in the page's main.js ($(".js-vacancies-list").data("url")), confirmed
// live 2026-09 (21 open vacancies across all categories):
//   GET /zen/hrhub/api/lists.Vacancy:addRecords?category_id=<1..5>&offset=<n, step 5>
//     -> JSON array [{id, name, url, hot, last_record, departments:[{id,name}], timefactors:[{name}],
//        spacefactors:[{name}]}], empty array (or last_record:true on the final item) when exhausted.
// No description/salary in the list; full text is server-rendered on each detail page at the job's
// own `url`, in repeating <div class="vacancy-body-item"><h2 class="vacancy-body-item__title">Section:
// </h2><div class="vacancy-body-item__text">...</div></div> blocks (Что предстоит делать / Что важно /
// Условия / ...), plus a trailing "зови друзей" referral-program block we drop. No numeric salary and
// no structured location field anywhere; a few titles carry a city in parens (e.g. "Супервайзер
// call-центра (Алматы)") but that's ambiguous with role-clarification parens elsewhere, so area is
// always left blank rather than guessed.
// Apply is a client-rendered form (POST /zen/forms/api/Capture:store: name/phone/email/telegram,
// resume-link or resume-file, agreement checkbox) gated by Google reCAPTCHA -> agent flow only, apply()
// omitted. Winline also cross-posts to hh.ru (employer id 991318, linked from every vacancy page).
import type { Discovered } from "@sgz/shared";
import { getJson, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://rabota.winline.ru";
const LIST_API = `${ORIGIN}/zen/hrhub/api/lists.Vacancy:addRecords`;
const CATEGORY_IDS = [1, 2, 3, 4, 5];
const PAGE_SIZE = 5;
const COMPANY = "Winline";

interface WinlineListItem {
  id: number;
  name: string;
  url: string;
  last_record?: boolean;
  departments?: { name: string }[];
  timefactors?: { name: string }[];
}

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "rabota.winline.ru") return { token: ORIGIN };
  return /rabota\.winline\.ru\/zen\/hrhub\/api\/lists\.Vacancy/.test(html) ? { token: ORIGIN } : null;
}

// No location field anywhere in list or detail data. A trailing "(...)" in the title is ambiguous -
// sometimes a real place ("Супервайзер call-центра (Алматы)", "Официант (м. Улица 1905 года)"),
// sometimes a role clarification ("Финансовый аналитик (Бонус-менеджер)") - so area is always left
// blank rather than guessed; the parenthetical stays readable in the title itself.

const toDiscovered = (v: WinlineListItem): Discovered => ({
  externalId: atsId("site:winline", v.id),
  url: v.url,
  title: v.name.trim(),
  company: COMPANY,
  raw: v,
});

async function listJobs(): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (const categoryId of CATEGORY_IDS) {
    for (let offset = 0; offset < 500; offset += PAGE_SIZE) {
      const page = await getJson<WinlineListItem[]>(`${LIST_API}?category_id=${categoryId}&offset=${offset}`);
      if (page.length === 0) break;
      out.push(...page.map(toDiscovered));
      if (page.some((v) => v.last_record)) break;
    }
  }
  return out;
}

const SECTION_RE = /vacancy-body-item__title">\s*<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?vacancy-body-item__text">([\s\S]*?)<\/div>\s*<\/div>/g;

// Sections are "Что предстоит делать:" / "Что важно:" / "Условия:" / ... followed by a trailing
// "зови друзей" referral-program block that isn't part of the job description.
function descriptionOf(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(SECTION_RE)) {
    const heading = stripHtml(m[1] ?? "").trim();
    if (!heading || /друз/i.test(heading)) continue;
    const body = stripHtml(m[2] ?? "").trim();
    if (body) parts.push(`${heading}\n${body}`);
  }
  return parts.join("\n\n");
}

const TAGS_RE = /vacancy-header__data-tags">([\s\S]*?)<\/div>/;
const TAG_RE = /<span class="b-btn b-btn-mini b-btn-grey">([^<]*)<\/span>/g;

// Tags are [department, work-schedule, employment-type, ...]; join the schedule/employment ones
// (everything after the department, which duplicates what listJobs already reports).
function workFormatOf(html: string): string {
  const block = TAGS_RE.exec(html)?.[1] ?? "";
  const tags = [...block.matchAll(TAG_RE)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
  return tags.slice(1).join(", ");
}

async function fetchJob(_token: string, d: Discovered): Promise<ReturnType<typeof makeVacancy>> {
  const html = await getText(d.url);
  return makeVacancy({
    source: "site:winline",
    externalId: d.externalId,
    url: d.url,
    title: d.title,
    company: d.company,
    descriptionText: descriptionOf(html),
    workFormat: workFormatOf(html),
  });
}

export const client: ATSClientImpl = {
  kind: "site:winline",
  verified: true,
  notes:
    "no docs; public JSON list GET /zen/hrhub/api/lists.Vacancy:addRecords?category_id=<1..5>&offset " +
    "(paginated 5/page, last_record:true or [] marks the end of a category; 21 vacancies live on 2026-09); " +
    "detail is server-rendered HTML on the job's own page (vacancy-body-item sections, trailing referral " +
    "block dropped); no salary ever published; city only appears in a few titles as a \"(City)\" suffix; " +
    "apply is a client form POSTing to /zen/forms/api/Capture:store behind Google reCAPTCHA -> agent flow only",
  jobsUrl: () => `${LIST_API}?category_id=1&offset=0`,
  detect,
  listJobs,
  fetchJob,
};
