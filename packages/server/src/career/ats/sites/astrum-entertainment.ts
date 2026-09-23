// Astrum Entertainment careers site (astrum-entertainment.ru/careers), a server-rendered Nuxt 2 app.
// No public JSON API (/api/* redirects, likely requires session); every page embeds its Nuxt state as
// `window.__NUXT__=(function(a,b,...){return {...}}(<args>))`. That IIFE is plain data (an object
// literal closing over positional args, no external calls), so we evaluate it in a locked-down vm
// context to recover the real object deterministically - far more robust than regex-parsing minified
// letter-named placeholders. Listing lives at fetch["data-v-*"].vacancies (id + job_title only, no
// location/salary); job detail lives at fetch["data-v-*"].vacancy (header/body/requirements/conditions
// HTML). Verified live 2026-09. No apply API found (React contact is a mailto: jobs@example.com on
// the careers page) -> apply() omitted.
//
// The edge sits behind a bot-protection layer: the first request to any page gets a 307-to-self with
// a one-time `bp_chl=...` Set-Cookie and never resolves on its own (redirect-follow loops forever).
// Replaying that cookie on a second request passes cleanly - no JS challenge execution needed, just a
// warm-up GET. We do that warm-up once per origin and cache the cookie (getText from ../../http.js
// has no cookie-jar hook, so this client makes its own minimal requests instead).
import vm from "node:vm";
import type { Discovered } from "@sgz/shared";
import { USER_AGENT, hostOf, originOf, stripHtml } from "../../http.js";
import { makeVacancy } from "../../vacancy.js";
import { atsId, rawId, type ATSClientImpl } from "../types.js";

const ORIGIN = "https://astrum-entertainment.ru";
const NUXT_RE = /<script[^>]*>\s*window\.__NUXT__=(\(function\([\s\S]*?\)\);?)\s*<\/script>/;

const challengeCookies = new Map<string, string>();

async function warmUpCookie(origin: string): Promise<string> {
  const cached = challengeCookies.get(origin);
  if (cached) return cached;
  const res = await fetch(origin, { headers: { "user-agent": USER_AGENT }, redirect: "manual" });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (cookie) challengeCookies.set(origin, cookie);
  return cookie;
}

/** GET text, passing the origin's bot-challenge cookie once we have one. */
async function getSiteText(origin: string, url: string): Promise<string> {
  const cookie = await warmUpCookie(origin);
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, ...(cookie ? { cookie } : {}) } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return await res.text();
}

interface ListFetchShape {
  vacancies?: { id: number; job_title?: string }[];
}
interface DetailFetchShape {
  vacancy?: { id: number; job_title?: string; header?: string; body?: string; requirements?: string; conditions?: string };
}

/** Pull the `fetch` bag out of a page's `window.__NUXT__` IIFE by evaluating it as inert data. */
function readNuxtFetch(html: string): Record<string, unknown> | null {
  const src = NUXT_RE.exec(html)?.[1];
  if (!src) return null;
  try {
    const nuxt = vm.runInNewContext(src, Object.create(null), { timeout: 1000 }) as {
      fetch?: Record<string, unknown>;
    };
    return nuxt.fetch ?? null;
  } catch {
    return null;
  }
}

function firstOfShape<T>(fetchBag: Record<string, unknown>, has: (v: unknown) => v is T): T | null {
  for (const v of Object.values(fetchBag)) if (has(v)) return v;
  return null;
}

const hasVacancies = (v: unknown): v is ListFetchShape =>
  !!v && typeof v === "object" && Array.isArray((v as ListFetchShape).vacancies);
const hasVacancy = (v: unknown): v is DetailFetchShape =>
  !!v && typeof v === "object" && typeof (v as DetailFetchShape).vacancy === "object";

function detect(baseUrl: string, html: string): { token: string } | null {
  if (hostOf(baseUrl) === "astrum-entertainment.ru") return { token: originOf(baseUrl) || ORIGIN };
  return /astrum-entertainment\.ru\/careers/i.test(html) ? { token: ORIGIN } : null;
}

const toDiscovered = (origin: string, id: number, title: string): Discovered => ({
  externalId: atsId("site:astrum-entertainment", id),
  url: `${origin}/careers/${id}`,
  title,
  company: "Astrum Entertainment",
});

async function listJobs(origin: string): Promise<Discovered[]> {
  const html = await getSiteText(origin, `${origin}/careers`);
  const fetchBag = readNuxtFetch(html);
  const list = fetchBag && firstOfShape(fetchBag, hasVacancies);
  const vacancies = list?.vacancies ?? [];
  return vacancies.filter((v) => v.job_title).map((v) => toDiscovered(origin, v.id, v.job_title as string));
}

function descriptionOf(v: NonNullable<DetailFetchShape["vacancy"]>): string {
  const section = (title: string, html?: string) => (html ? `${title}:\n${stripHtml(html)}` : "");
  return [stripHtml(v.header ?? ""), section("Чем предстоит заниматься", v.body), section("Требования", v.requirements), section("Условия", v.conditions)]
    .filter(Boolean)
    .join("\n\n");
}

async function fetchJob(origin: string, d: Discovered) {
  const id = rawId(d.externalId);
  const url = `${origin}/careers/${id}`;
  const html = await getSiteText(origin, url);
  const fetchBag = readNuxtFetch(html);
  const detail = fetchBag && firstOfShape(fetchBag, hasVacancy);
  const v = detail?.vacancy;
  return makeVacancy({
    source: "site:astrum-entertainment",
    externalId: d.externalId,
    url,
    title: v?.job_title ?? d.title,
    company: "Astrum Entertainment",
    descriptionText: v ? descriptionOf(v) : "",
  });
}

export const client: ATSClientImpl = {
  kind: "site:astrum-entertainment",
  verified: true,
  notes:
    "no public JSON API (/api/* redirects); list and detail read from window.__NUXT__ embedded in " +
    "server-rendered HTML at /careers and /careers/{id} (evaluated as inert data via node:vm, not regex); " +
    "listing has no location/salary, only id+job_title; detail has header/body/requirements/conditions HTML, " +
    "no salary published; no apply API found, careers page only lists a mailto: jobs@example.com -> no apply()",
  jobsUrl: (token) => `${token}/careers`,
  detect,
  listJobs,
  fetchJob,
};
