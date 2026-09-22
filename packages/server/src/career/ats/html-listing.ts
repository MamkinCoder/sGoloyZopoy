// Generic careers page → job links, for hosted RU platforms without a public JSON API (Huntflow, Potok).
// The token is the careers page origin; jobs are internal links that look like a vacancy page.
// UNVERIFIED against live sites — treated as a best-effort fallback to the agent flow.
import type { ATSKind, Discovered } from "@sgz/shared";
import { extractLinks, getText, hostOf, originOf, stripHtml } from "../http.js";
import { makeVacancy } from "../vacancy.js";
import { atsId, type ATSClientImpl } from "./types.js";

const VACANCY_PATH = /\/(vacanc(y|ies)|jobs?|positions?|careers?|openings?|vacancy)\/[^/?#]+/i;

export function extractJobLinks(html: string, pageUrl: string, kind: ATSKind): Discovered[] {
  const origin = originOf(pageUrl);
  const seen = new Set<string>();
  const out: Discovered[] = [];
  for (const l of extractLinks(html, pageUrl)) {
    if (!l.href.startsWith(origin) || !VACANCY_PATH.test(new URL(l.href).pathname)) continue;
    const key = l.href.replace(/[#?].*$/, "");
    if (seen.has(key) || l.text.length < 3 || l.text.length > 120) continue;
    seen.add(key);
    out.push({ externalId: atsId(kind, key), url: key, title: l.text, company: "" });
  }
  return out;
}

export function htmlListingClient(kind: ATSKind, hostRe: RegExp, markerRe: RegExp, notes: string): ATSClientImpl {
  return {
    kind,
    verified: false,
    notes,
    jobsUrl: (origin) => origin,
    detect(baseUrl, html) {
      const origin = originOf(baseUrl);
      if (!origin) return null;
      if (hostRe.test(hostOf(baseUrl)) || markerRe.test(html)) return { token: baseUrl };
      return null;
    },
    async listJobs(pageUrl) {
      return extractJobLinks(await getText(pageUrl), pageUrl, kind);
    },
    async fetchJob(_pageUrl, d) {
      const html = await getText(d.url);
      const title = stripHtml(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "") || d.title;
      return makeVacancy({ source: kind, externalId: d.externalId, url: d.url, title, company: d.company, descriptionText: stripHtml(html) });
    },
  };
}

export const huntflow = htmlListingClient(
  "huntflow",
  /(^|\.)huntflow\.(io|ru)$/,
  /huntflow\.(io|ru)\/|data-huntflow|huntflow-career/i,
  "no public JSON found; careers page links parsed by regex (unverified) → agent flow for apply",
);

export const potok = htmlListingClient(
  "potok",
  /(^|\.)potok\.io$/,
  /potok\.io\/|data-potok|potok-widget/i,
  "no public JSON found; careers page links parsed by regex (unverified) → agent flow for apply",
);
