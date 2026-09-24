// Knowledge-base writes: seed import (idempotent by story hash), ingested stories, deterministic guards,
// and the one-way sync of tag statuses into profile.verified_skills / never_claim_skills for older code paths.
import { createHash } from "node:crypto";
import { tagIs, tagKey, type KbStory, type KbStorySource, type KbTag, type KbTagStatus, type Profile, type Store } from "@sgz/shared";
import { enforceMax, normalizeProse, splitSentences, stripLinkSentences, stripNeverClaimSentences } from "../llm/guards.js";

/** A story as the LLM / a seed file carries it: tags by name. */
export interface KbStoryDraft {
  title: string;
  company: string;
  period: string;
  context: string;
  did: string;
  result: string;
  tags: string[];
}

export interface KbSeedTag {
  name: string;
  aliases: string[];
  category: string;
  status: KbTagStatus;
}

/** `sgz kb seed --dry-run` output and `--from` input. */
export interface KbSeed {
  tags: KbSeedTag[];
  stories: KbStoryDraft[];
}

const norm = (s: string) => tagKey(s);

/** Same facts, same hash: whitespace, case and tag order do not matter. */
export function storyHash(s: KbStoryDraft): string {
  const key = [s.title, s.company, s.period, s.context, s.did, s.result].map(norm).join("\u0001") + "\u0001" + s.tags.map(norm).sort().join(",");
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

// ---- guards

/** Numbers as they may be written: «2,5» == «2.5», «1 000» stays two numbers (rare, still conservative). */
export const numbersIn = (text: string): string[] => (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));

// Quantities written in words: «вдвое», «в три раза», «в разы», «десятки», «сотни тысяч», «миллион».
const QTY_WORD_RE =
  /(?<!\p{L})(?:вдвое|втрое|вчетверо|впятеро|вдесятеро|в\s+разы|(?:два|три|четыре|пять|шесть|семь|восемь|девять|десять|несколько|много)\s+раз\p{L}*|десят(?:ки|ков|ками)|сот(?:ни|ен|нями)|тысяч\p{L}*|миллион\p{L}*|миллиард\p{L}*)(?!\p{L})/giu;

/**
 * What a text claims numerically: every digit number with its unit («3|раз», «30|%»; years and unit-less numbers
 * bare) and every quantity word. A story's claim must appear with the same unit in the sources: «Python 3» or
 * «3 года» there do not allow «в 3 раза» here.
 */
export function numberClaims(text: string): string[] {
  const t = text.toLowerCase().replace(/ё/g, "е");
  const out: string[] = [];
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)(?:\s*(%)|\s+(\p{L}{3,}))?/gu)) {
    const n = m[1]!.replace(",", ".");
    const unit = /^(?:19|20)\d\d$/.test(n) ? "" : (m[2] ?? m[3]?.slice(0, 3) ?? "");
    out.push(unit ? `${n}|${unit}` : n);
  }
  for (const m of t.matchAll(QTY_WORD_RE)) out.push(`~${m[0].split(/\s+/).map((w) => w.slice(0, 4)).join(" ")}`);
  return out;
}

/** The claims the sources allow: their numbers with units, bare, and their quantity words. */
export const allowedNumbers = (sources: string): Set<string> => new Set([...numberClaims(sources), ...numbersIn(sources)]);

/** Drops every sentence carrying a number (digits or words) the sources do not contain with the same unit. */
export function stripInventedNumbers(text: string, allowed: Set<string>): string {
  if (!numberClaims(text).length) return text;
  return splitSentences(text)
    .filter((s) => numberClaims(s).every((n) => allowed.has(n)))
    .join(" ")
    .trim();
}

const FIELD_MAX = { title: 100, context: 400, did: 600, result: 400 } as const;

/** One story through every deterministic check; null when nothing usable is left. */
export function guardStory(s: KbStoryDraft, o: { allowedNumbers: Set<string>; never: string[]; companies?: string[] }): KbStoryDraft | null {
  const clean = (t: string, max: number) =>
    enforceMax(stripNeverClaimSentences(stripInventedNumbers(stripLinkSentences(normalizeProse(t.replace(/\s*\n\s*/g, " "))), o.allowedNumbers), o.never), max);
  const did = clean(s.did, FIELD_MAX.did);
  if (!did) return null;
  const period = numbersIn(s.period).every((n) => o.allowedNumbers.has(n)) ? normalizeProse(s.period) : "";
  const company = normalizeProse(s.company);
  const known = !o.companies || !company || o.companies.some((c) => norm(c).includes(norm(company)) || norm(company).includes(norm(c)));
  const tags = [...new Map(s.tags.map((t) => t.trim()).filter(Boolean).map((t) => [norm(t), t])).values()].slice(0, 8);
  return {
    title: clean(s.title, FIELD_MAX.title) || tags.slice(0, 3).join(", ") || "Без названия",
    company: known ? company : "",
    period: known ? period : "",
    context: clean(s.context, FIELD_MAX.context),
    did,
    result: clean(s.result, FIELD_MAX.result),
    tags,
  };
}

// ---- store writes

export interface ApplyResult {
  tagsAdded: number;
  storiesAdded: number;
  storiesSkipped: number;
}

/** Tag ids for names, creating missing tags with status unknown. */
const tagIds = (store: Store, userId: number, names: string[]): number[] =>
  names.map((name) => store.listKbTags(userId).find((t) => tagIs(t, name))?.id ?? store.upsertKbTag(userId, { name }).id);

/** Inserts stories whose hash is not stored yet; never touches existing rows. */
export function addStories(store: Store, userId: number, drafts: (KbStoryDraft & { hash?: string })[], o: { source: KbStorySource; confirmed: boolean }): { added: KbStory[]; skipped: number } {
  const known = new Set(store.listKbStories(userId).map((s) => s.hash).filter(Boolean));
  const added: KbStory[] = [];
  let skipped = 0;
  for (const d of drafts) {
    const hash = d.hash ?? storyHash(d);
    if (known.has(hash)) {
      skipped++;
      continue;
    }
    known.add(hash);
    const { tags, hash: _h, ...fields } = d;
    added.push(store.saveKbStory({ ...fields, userId, source: o.source, confirmed: o.confirmed, hash, tagIds: tagIds(store, userId, tags) }));
  }
  return { added, skipped };
}

/**
 * Seed import. New tags get the seed's status; an existing tag only gains aliases/category, and its status only
 * while it is still `unknown` (a human's yes/no wins). Stories are added by hash, nothing is deleted or edited.
 * A story is skipped when its hash was ever imported (a story the human deleted stays deleted) or a story with the
 * same company + title exists (a re-run of the LLM words the same story differently). The hash is taken before
 * `no` tags leave the draft, so marking a tag `no` between runs does not re-import its stories.
 */
export function applySeed(store: Store, userId: number, seed: KbSeed): ApplyResult {
  const before = store.listKbTags(userId).length;
  for (const t of seed.tags) {
    const cur = store.listKbTags(userId).find((x) => [t.name, ...t.aliases].some((n) => tagIs(x, n))); // as upsertKbTag matches
    const status = !cur || cur.status === "unknown" ? t.status : undefined;
    store.upsertKbTag(userId, { name: t.name, aliases: t.aliases, category: t.category, status });
  }
  const noTags = store.listKbTags(userId).filter((t) => t.status === "no");
  const ledgerKey = `kb_seed_hashes:${userId}`;
  const imported = new Set<string>(parseList(store.getSetting(ledgerKey)));
  const titleKey = (s: { company: string; title: string }) => `${norm(s.company)}\u0001${norm(s.title)}`;
  const titles = new Set(store.listKbStories(userId).map(titleKey));
  const drafts: (KbStoryDraft & { hash: string })[] = [];
  let dup = 0;
  for (const s of seed.stories) {
    const hash = storyHash(s);
    if (imported.has(hash) || titles.has(titleKey(s))) {
      dup++;
      continue;
    }
    titles.add(titleKey(s));
    drafts.push({ ...s, hash, tags: s.tags.filter((n) => !noTags.some((t) => tagIs(t, n))) });
  }
  const { added, skipped } = addStories(store, userId, drafts, { source: "seed", confirmed: false });
  for (const d of drafts) imported.add(d.hash);
  store.setSetting(ledgerKey, JSON.stringify([...imported]));
  syncProfileSkills(store, userId);
  return { tagsAdded: store.listKbTags(userId).length - before, storiesAdded: added.length, storiesSkipped: skipped + dup };
}

const parseList = (raw: string | null): string[] => {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

// ---- profile sync

/**
 * Profile lists with the KB statuses applied: a `yes` tag is in verified_skills and out of never_claim_skills,
 * a `no` tag the other way round; `unknown` tags and skills without a tag stay as they are.
 */
export function withKbSkills<P extends Pick<Profile, "verified_skills" | "never_claim_skills">>(p: P, tags: Pick<KbTag, "name" | "aliases" | "status">[]): P {
  const yes = tags.filter((t) => t.status === "yes");
  const no = tags.filter((t) => t.status === "no");
  // Removal by name only: an alias must never delete an entry from the human's lists.
  const hit = (list: typeof tags, s: string) => list.some((t) => tagKey(t.name) === tagKey(s));
  const missing = (list: typeof tags, have: string[]) => list.filter((t) => !have.some((s) => tagIs(t, s))).map((t) => t.name);
  const verified = p.verified_skills.filter((s) => !hit(no, s));
  const never = p.never_claim_skills.filter((s) => !hit(yes, s));
  return { ...p, verified_skills: [...verified, ...missing(yes, verified)], never_claim_skills: [...never, ...missing(no, never)] };
}

/**
 * The reverse direction, for a human editing the profile lists (panel): tags follow the edit, or the next
 * syncProfileSkills would revert it. By tag name: in never_claim -> no, in verified -> yes, in neither -> unknown;
 * a tag the lists only name by an alias keeps its status.
 */
export function applyProfileSkills(store: Store, userId: number, p: Pick<Profile, "verified_skills" | "never_claim_skills">): void {
  const has = (list: string[], n: string) => list.some((s) => norm(s) === norm(n));
  const all = [...p.verified_skills, ...p.never_claim_skills];
  for (const t of store.listKbTags(userId)) {
    const next: KbTagStatus = has(p.never_claim_skills, t.name) ? "no" : has(p.verified_skills, t.name) ? "yes" : all.some((s) => tagIs(t, s)) ? t.status : "unknown";
    if (next !== t.status) store.setKbTagStatus(t.id, next);
  }
}

/** Writes withKbSkills into the stored profile; true when it changed. Call after any tag status change. */
export function syncProfileSkills(store: Store, userId: number): boolean {
  const p = store.getProfile(userId);
  if (!p) return false;
  const next = withKbSkills(p, store.listKbTags(userId));
  if (JSON.stringify(next) === JSON.stringify(p)) return false;
  store.saveProfile(userId, next);
  return true;
}
