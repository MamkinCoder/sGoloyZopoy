// Universal career-site agent: ATS JSON when we know the platform, otherwise natural-language
// act/extract guided by SiteProfile hints that onboarding writes for itself.
import { canonicalUrl } from "@sgz/shared";
import type { ATSKind, BrowserSession, CareerAgent, CareerApplyRequest, CareerApplyResult, CareerSite, Discovered, LLMClient, SiteProfile } from "@sgz/shared";
import { applyViaAgent } from "./agent-apply.js";
import { atsClientFor, atsClientImpls, type ATSClientImpl } from "./ats/index.js";
import { extractLinks, truncate, type Link } from "./http.js";
import { ONBOARD_SCHEMA_DESCRIPTION, jobListSchema, onboardAnswerSchema, vacancyPageSchema, type OnboardAnswer } from "./schemas.js";
import { makeVacancy, type VacancyDraft } from "./vacancy.js";

export interface CareerAgentOptions {
  clients?: ATSClientImpl[];
  now?: () => Date;
  log?: (message: string) => void;
}

export const DISCOVER_MAX_PAGES = 5;
export const DISCOVER_CAP = 100;
const PAGE_TEXT_MAX = 8000;
const LINKS_MAX = 300;

const COLLECT_LINKS_JS = `Array.from(document.querySelectorAll("a[href]")).slice(0, 2000).map(a => ({ href: a.href, text: (a.innerText || a.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120) }))`;

export function createCareerAgent(llm: LLMClient, opts: CareerAgentOptions = {}): CareerAgent {
  const clients = opts.clients ?? atsClientImpls;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const clientFor = (kind: ATSKind): ATSClientImpl | undefined =>
    opts.clients ? clients.find((c) => c.kind === kind) : atsClientFor(kind);

  const detect = (baseUrl: string, html: string): { kind: ATSKind; token: string } | null => {
    for (const c of clients) {
      const hit = c.detect(baseUrl, html);
      if (hit) return { kind: c.kind, token: hit.token };
    }
    return null;
  };

  const tokenOf = (site: CareerSite): string => {
    const token = site.profile.ats_board_token;
    if (!token) throw new Error(`site ${site.slug}: ats "${site.ats}" without profile.ats_board_token`);
    return token;
  };

  async function onboard(s: BrowserSession, baseUrl: string, hints?: string): Promise<{ ats: ATSKind; profile: SiteProfile }> {
    await s.goto(baseUrl);
    const currentUrl = (await s.url().catch(() => baseUrl)) || baseUrl;
    const html = await s.html();
    const det = detect(baseUrl, html) ?? detect(currentUrl, html);
    if (det) {
      const client = clientFor(det.kind);
      const profile: SiteProfile = {
        listing_url: currentUrl,
        ats_board_token: det.token,
        apply_mode: client?.apply ? "ats_api" : "agent",
        notes: [client?.notes, hints && `operator: ${hints}`].filter(Boolean).join("; "),
        last_verified_at: now().toISOString(),
      };
      const jsonUrl = client?.jobsUrl(det.token);
      if (jsonUrl) profile.jobs_json_url = jsonUrl;
      if (det.kind === "hh_hosted") delete profile.apply_mode;
      log(`onboard ${baseUrl}: ats=${det.kind} token=${det.token}`);
      return { ats: det.kind, profile };
    }
    return { ats: "custom", profile: await onboardCustom(s, baseUrl, currentUrl, html, hints) };
  }

  async function onboardCustom(s: BrowserSession, baseUrl: string, pageUrl: string, html: string, hints?: string): Promise<SiteProfile> {
    const ask = async (url: string, pageHtml: string, note: string): Promise<OnboardAnswer> => {
      const text = await s.text(PAGE_TEXT_MAX);
      const links = await collectLinks(s, url, pageHtml);
      const raw = await llm.json<unknown>("site_onboard", "write", onboardPrompt(baseUrl, url, text, links, hints, note), ONBOARD_SCHEMA_DESCRIPTION);
      const parsed = onboardAnswerSchema.safeParse(raw);
      return parsed.success ? parsed.data : {};
    };

    let answer = await ask(pageUrl, html, "");
    let listing = resolveUrl(answer.listing_url ?? "", pageUrl) ?? pageUrl;
    let found = await verifyListing(s, listing, answer.discover_hints ?? "");
    if (found === 0) {
      const url2 = (await s.url().catch(() => listing)) || listing;
      const html2 = await s.html().catch(() => "");
      answer = await ask(url2, html2, `A previous guess listing_url=${listing} showed no job postings; pick another page or explain how the list loads.`);
      const listing2 = resolveUrl(answer.listing_url ?? "", url2) ?? listing;
      found = await verifyListing(s, listing2, answer.discover_hints ?? "");
      listing = listing2;
    }
    log(`onboard ${baseUrl}: custom listing=${listing} postings=${found}`);
    const profile: SiteProfile = {
      listing_url: listing,
      apply_mode: "agent",
      discover_hints: (answer.discover_hints ?? "").trim() || undefined,
      apply_hints: (answer.apply_hints ?? "").trim() || undefined,
      notes: [answer.notes?.trim(), found ? `verified ${found} postings on listing_url` : "listing_url NOT verified: no postings extracted", hints && `operator: ${hints}`]
        .filter(Boolean)
        .join("; "),
      last_verified_at: now().toISOString(),
    };
    return profile;
  }

  async function verifyListing(s: BrowserSession, listing: string, discoverHints: string): Promise<number> {
    try {
      await s.goto(listing);
      const res = await s.extract(discoverInstruction(discoverHints), jobListSchema);
      return res.jobs.filter((j) => j.title.trim() && j.url.trim()).length;
    } catch (err) {
      log(`verifyListing ${listing} failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async function discover(s: BrowserSession | null, site: CareerSite, filters: string[]): Promise<Discovered[]> {
    if (site.ats === "hh_hosted") return [];
    const keywords = filters.length ? filters : (site.profile.filters ?? []);
    let items: Discovered[];
    const client = site.ats !== "custom" ? clientFor(site.ats) : undefined;
    if (client) {
      items = await client.listJobs(tokenOf(site));
    } else {
      if (!s) throw new Error(`site ${site.slug}: browser session required to discover a custom site`);
      items = await discoverCustom(s, site);
    }
    const named = items.map((d) => ({ ...d, company: site.name || d.company }));
    return filterByKeywords(named, keywords).slice(0, DISCOVER_CAP);
  }

  async function discoverCustom(s: BrowserSession, site: CareerSite): Promise<Discovered[]> {
    const start = site.profile.listing_url ?? site.baseUrl;
    await s.goto(start);
    const seen = new Map<string, Discovered>();
    for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
      const pageUrl = (await s.url().catch(() => start)) || start;
      const res = await s.extract(discoverInstruction(site.profile.discover_hints ?? ""), jobListSchema);
      let added = 0;
      for (const j of res.jobs) {
        const abs = resolveUrl(j.url, pageUrl);
        if (!abs || !j.title.trim()) continue;
        const id = canonicalUrl(abs);
        if (seen.has(id)) continue;
        seen.set(id, { externalId: id, url: abs, title: j.title.trim(), company: "", location: j.location?.trim() || undefined });
        added++;
      }
      log(`discover ${site.slug}: page ${page + 1} +${added} (total ${seen.size})`);
      if (added === 0 || seen.size >= DISCOVER_CAP) break;
      const next = await s.act(
        "Load more job postings: scroll to the bottom of the list and click a 'show more' / 'load more' / 'Показать ещё' button, or go to the next page of results if there is pagination",
        { cacheKey: "career.discover.next" },
      );
      if (!next.success) break;
    }
    return [...seen.values()];
  }

  async function fetch(s: BrowserSession | null, site: CareerSite, d: Discovered): Promise<VacancyDraft> {
    const client = site.ats !== "custom" ? clientFor(site.ats) : undefined;
    if (client) {
      const v = await client.fetchJob(tokenOf(site), d);
      return makeVacancy({ ...v, source: site.slug, company: site.name || v.company });
    }
    if (!s) throw new Error(`site ${site.slug}: browser session required to fetch a custom vacancy`);
    await s.goto(d.url);
    const x = await s.extract(
      "Extract this job posting: title, company name, the full description text (responsibilities, requirements, conditions - as plain text), location, salary as written (if shown), and work format (remote/office/hybrid) if stated.",
      vacancyPageSchema,
    );
    const salary = parseSalary(x.salary ?? "");
    return makeVacancy({
      source: site.slug,
      externalId: d.externalId,
      url: d.url,
      title: x.title.trim() || d.title,
      company: site.name || x.company || d.company,
      descriptionText: x.description,
      area: x.location?.trim() || d.location || "",
      workFormat: x.work_format?.trim() ?? "",
      salaryFrom: salary.from,
      salaryTo: salary.to,
      currency: salary.currency,
    });
  }

  async function apply(s: BrowserSession, req: CareerApplyRequest): Promise<CareerApplyResult> {
    const client = req.site.ats !== "custom" ? clientFor(req.site.ats) : undefined;
    if (req.site.profile.apply_mode === "ats_api" && client?.apply && req.site.profile.ats_board_token) {
      try {
        const r = await client.apply(req.site.profile.ats_board_token, req);
        if (r) return r;
        log(`apply ${req.site.slug}: ats api declined, falling back to agent`);
      } catch (err) {
        log(`apply ${req.site.slug}: ats api error ${err instanceof Error ? err.message : String(err)}, falling back to agent`);
      }
    }
    return applyViaAgent(s, req);
  }

  return { onboard, discover, fetch, apply };
}

export function discoverInstruction(hints: string): string {
  return (
    "Extract the list of job postings (vacancies) shown on this page: for each give its title, the link URL to the posting, and location if shown. Ignore navigation, blog and non-job links." +
    (hints ? ` Hints: ${hints}` : "")
  );
}

function onboardPrompt(baseUrl: string, pageUrl: string, text: string, links: Link[], hints: string | undefined, note: string): string {
  const linkLines = links.map((l) => `${l.href} — ${l.text}`).join("\n");
  return [
    "You are onboarding a company careers site for an automated job-application agent that later reads the page with natural-language instructions.",
    `Base URL: ${baseUrl}`,
    `Current page URL: ${pageUrl}`,
    hints ? `Operator hints: ${hints}` : "",
    note,
    "Decide which page lists the open vacancies (listing_url, absolute URL; use the current page if it already lists them), how the agent should find and paginate postings there (discover_hints), and how applying works on this site (apply_hints).",
    `Page text (truncated to ${PAGE_TEXT_MAX} chars):\n${truncate(text, PAGE_TEXT_MAX)}`,
    `Links on the page (${links.length}):\n${linkLines}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function collectLinks(s: BrowserSession, pageUrl: string, html: string): Promise<Link[]> {
  try {
    const raw = await s.evaluate<unknown>(COLLECT_LINKS_JS);
    if (Array.isArray(raw)) {
      const links = raw
        .filter((l): l is Link => !!l && typeof l === "object" && typeof (l as Link).href === "string")
        .map((l) => ({ href: l.href, text: String(l.text ?? "") }));
      if (links.length) return dedupeLinks(links).slice(0, LINKS_MAX);
    }
  } catch {
    // fall back to the regex extractor below
  }
  return dedupeLinks(extractLinks(html, pageUrl)).slice(0, LINKS_MAX);
}

function dedupeLinks(links: Link[]): Link[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    if (!/^https?:/i.test(l.href) || seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });
}

export function resolveUrl(raw: string, base: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(t, base);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Case-insensitive keyword filter on the title; empty keyword list keeps everything. */
export function filterByKeywords(items: Discovered[], keywords: string[]): Discovered[] {
  const kws = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return items;
  return items.filter((d) => {
    const t = d.title.toLowerCase();
    return kws.some((k) => t.includes(k));
  });
}

/** "от 200 000 до 300 000 ₽" → {from: 200000, to: 300000, currency: "RUB"}; best effort, 0 when unknown. */
export function parseSalary(text: string): { from: number; to: number; currency: string } {
  const nums = [...text.replace(/(\d)[  ](?=\d{3}\b)/g, "$1").matchAll(/(\d+(?:[.,]\d+)?)\s*(k|к|тыс)?/gi)]
    .map((m) => Math.round(parseFloat((m[1] ?? "0").replace(",", ".")) * (m[2] ? 1000 : 1)))
    .filter((n) => n >= 1000);
  const currency = /₽|руб|rub/i.test(text) ? "RUB" : /\$|usd/i.test(text) ? "USD" : /€|eur/i.test(text) ? "EUR" : nums.length ? "RUB" : "";
  const toOnly = /^\s*(до|up to|to)\b/i.test(text);
  return { from: toOnly ? 0 : (nums[0] ?? 0), to: toOnly ? (nums[0] ?? 0) : (nums[1] ?? 0), currency };
}
