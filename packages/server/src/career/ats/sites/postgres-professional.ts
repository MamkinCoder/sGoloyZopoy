// Postgres Professional careers site (career.postgrespro.ru), a Next.js app-router site that
// server-renders both the listing and detail pages (no client fetch needed to read jobs; apply
// goes through an internal Huntflow proxy route, /api/save_huntflow_applicant, that isn't a public
// listing API). postgrespro.ru/vacancies and /jobs both redirect here. No public JSON API found.
// The homepage/#jobs section server-renders every open vacancy as a card:
// <a class="...mui-154irvp" href="/vacancies/<id>"><...><p class="...mui-t5avwy">TITLE</p>.
// The category chips above the cards (Sales, Information Security, ...) are just labels, not a
// filter that hides cards - reading the page once returns every open vacancy. Detail pages
// server-render the full text as plain paragraphs/lists inside the MUI content box that follows
// the title; no JSON-LD, no salary, no structured location ever exposed (office/remote, if any, is
// mentioned only inline in the prose). Apply is a client-rendered MUI form (ФИО, Телефон, Telegram,
// Почта, Ссылка на резюме, Сопроводительное письмо, resume file <=15MB, consent checkbox) posted to
// the Huntflow proxy route - no public apply API, so apply() is omitted; agent flow only.
// Verified live 2026-09 (1 open vacancy: "Tech Presale 1С", id 170444641).
import type { Discovered } from "@sgz/shared";
import { decodeEntities, getText, hostOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://career.postgrespro.ru";
const COMPANY = "Postgres Professional";

const CARD_RE = /<a class="[^"]*mui-154irvp[^"]*" href="(\/vacancies\/\d+)"[^>]*>[\s\S]*?class="[^"]*mui-t5avwy[^"]*">([\s\S]*?)<\/p>/g;

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "career.postgrespro.ru") return { token: ORIGIN };
  return /career\.postgrespro\.ru\/vacancies/i.test(html) ? { token: ORIGIN } : null;
}

function parseListing(html: string): Discovered[] {
  const out = new Map<string, Discovered>();
  for (const m of html.matchAll(CARD_RE)) {
    const path = m[1];
    const title = stripHtml(decodeEntities(m[2] ?? "")).trim();
    if (!path || !title) continue;
    const id = path.split("/").pop() ?? path;
    out.set(id, {
      externalId: atsId("site:postgres-professional", id),
      url: `${ORIGIN}${path}`,
      title,
      company: COMPANY,
    });
  }
  return [...out.values()];
}

async function listJobs(): Promise<Discovered[]> {
  const html = await getText(`${ORIGIN}/vacancies`);
  return parseListing(html);
}

// The detail page's content box runs from the title paragraph up to the apply form's first field
// label ("ФИО"); everything in between is plain prose/list paragraphs, no salary or structured area.
const CONTENT_RE = /class="[^"]*mui-s9afaf[^"]*">([\s\S]*?)<label[^>]*>ФИО</;

function descriptionOf(html: string): string {
  const body = CONTENT_RE.exec(html)?.[1] ?? "";
  return stripHtml(decodeEntities(body));
}

async function fetchJob(_token: string, d: Discovered) {
  const id = rawId(d.externalId);
  const url = `${ORIGIN}/vacancies/${id}`;
  const html = await getText(url);
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = titleMatch ? stripHtml(decodeEntities(titleMatch)).trim() : d.title;
  return makeVacancy({
    source: "site:postgres-professional",
    externalId: d.externalId,
    url,
    title,
    company: COMPANY,
    descriptionText: descriptionOf(html),
  });
}

export const client: ATSClientImpl = {
  kind: "site:postgres-professional",
  verified: true,
  notes:
    "no public JSON API; GET /vacancies server-renders every open vacancy card (category chips are " +
    "labels, not a filter - one page has them all); detail pages server-render plain prose/list " +
    "paragraphs (no salary, no structured location - ever mentioned only inline in text). Apply is a " +
    "client-rendered form (name, phone, Telegram, email, resume link, cover letter, resume file " +
    "<=15MB, consent checkbox) posted to an internal Huntflow proxy route - no public apply API " +
    "found -> agent flow only",
  jobsUrl: () => `${ORIGIN}/vacancies`,
  detect,
  listJobs,
  fetchJob,
};
