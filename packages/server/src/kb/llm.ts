// LLM passes that fill the knowledge base: kb_seed (base CVs + profile + Habr proposal -> tags + stories) and
// kb_ingest (a human's free-text story about one tag -> structured stories). Output always goes through guardStory.
import { tagIs, tagKey, type CV, type KbStory, type LLMClient, type Profile, type Store } from "@sgz/shared";
import { neverClaimList, profileForLLM } from "../llm/format.js";
import { KbIngestSchema, KbSeedSchema } from "../llm/schemas.js";
import { renderPrompt } from "../llm/template.js";
import { addStories, allowedNumbers as allowedIn, guardStory, syncProfileSkills, type KbSeed, type KbSeedTag, type KbStoryDraft } from "./write.js";

export interface SeedSources {
  profile: Profile;
  /** Base CVs without contacts / name / photo. */
  cvs: Omit<CV, "contacts" | "name">[];
  /** The approved Habr proposal (about, experiences, skills), or null. */
  habr: unknown;
}

const SEED_SCHEMA = `\`\`\`json
{
  "tags": [{ "name": string, "aliases": string[], "category": string }],
  "stories": [{ "title": string, "company": string, "period": string, "context": string, "did": string, "result": string, "tags": string[] }]
}
\`\`\``;

const INGEST_SCHEMA = `\`\`\`json
{ "stories": [{ "title": string, "company": string, "period": string, "context": string, "did": string, "result": string, "tags": string[] }] }
\`\`\``;

const MAX_INGEST_STORIES = 3;

/** Companies named in the sources: CV jobs and Habr experiences. */
function sourceCompanies(src: SeedSources): string[] {
  const habr = (src.habr as { experiences?: { company?: string }[] } | null)?.experiences ?? [];
  return [...src.cvs.flatMap((cv) => cv.jobs.map((j) => j.company)), ...habr.map((e) => e.company ?? "")].filter(Boolean);
}

export function seedPrompt(src: SeedSources): string {
  return renderPrompt("kb_seed", {
    never_claim: neverClaimList(src.profile),
    profile: profileForLLM(src.profile),
    verified: src.profile.verified_skills.join(", ") || "(пусто)",
    cvs: src.cvs,
    habr: src.habr ?? "",
  });
}

/**
 * Deterministic part of the seed: tag statuses come from the profile (verified -> yes, never_claim -> no,
 * everything else unknown), every listed skill gets a tag, stories keep only numbers present in the sources.
 */
export function guardSeed(raw: { tags: Omit<KbSeedTag, "status">[]; stories: KbStoryDraft[] }, src: SeedSources): KbSeed {
  const p = src.profile;
  const tags: KbSeedTag[] = [];
  const has = (list: string[], n: string) => list.some((s) => tagKey(s) === tagKey(n));
  const skills = [...p.verified_skills, ...p.never_claim_skills];
  const add = (t: Omit<KbSeedTag, "status">) => {
    const name = t.name.trim();
    if (!name) return;
    // An alias naming another profile skill («Docker Swarm» on «Docker») is a different skill: it must neither decide
    // this tag's status nor later make the profile sync treat the two as one. It survives only as the one alias that
    // names this tag («Go» on «Golang») when the name itself is not in the profile.
    const aliases = t.aliases.map((a) => a.trim()).filter(Boolean);
    const named = aliases.filter((a) => has(skills, a) && tagKey(a) !== tagKey(name));
    const decider = !has(skills, name) && named.length === 1 ? named[0]! : undefined;
    const safe = aliases.filter((a) => a === decider || !named.includes(a));
    const cur = tags.find((x) => tagIs(x, name) || safe.some((a) => tagIs(x, a)));
    if (cur) {
      cur.aliases = [...new Set([...cur.aliases, ...safe.filter((a) => !has(skills, a) || tagKey(a) === tagKey(cur.name))])];
      return;
    }
    const key = decider ?? name;
    const status = has(p.never_claim_skills, key) ? "no" : has(p.verified_skills, key) ? "yes" : "unknown";
    tags.push({ name, aliases: safe.slice(0, 8), category: t.category.trim(), status });
  };
  raw.tags.forEach(add);
  for (const s of p.verified_skills) add({ name: s, aliases: [], category: "" });
  for (const s of p.never_claim_skills) add({ name: s, aliases: [], category: "" });

  // JSON escapes («\n») would glue a newline to the next unit word.
  const allowedNumbers = allowedIn(JSON.stringify(src).replace(/\\[nrt]/g, " "));
  const companies = sourceCompanies(src);
  const stories = raw.stories
    .map((s) => guardStory(s, { allowedNumbers, never: p.never_claim_skills, companies }))
    .filter((s): s is KbStoryDraft => !!s)
    .map((s) => ({ ...s, tags: s.tags.filter((n) => !tags.some((t) => t.status === "no" && tagIs(t, n))) }));
  for (const s of stories) for (const n of s.tags) add({ name: n, aliases: [], category: "" });
  return { tags, stories };
}

/** One LLM pass over the sources; nothing is written. */
export async function seedKb(llm: LLMClient, src: SeedSources): Promise<KbSeed> {
  const raw = await llm.json<unknown>("kb_seed", "write", seedPrompt(src), SEED_SCHEMA);
  return guardSeed(KbSeedSchema.parse(raw), src);
}

export interface IngestInput {
  /** The tag the human was asked about. */
  tag: string;
  /** The human's own words. */
  text: string;
  /** Places of work to map names and periods to, e.g. «Яндекс (Недвижимость), 2022-2024». */
  companies?: string[];
}

/**
 * The human's story -> 1..3 structured stories. Pure: numbers survive only when the human wrote them (or they are
 * in the companies list), the asked tag is always linked. Empty when nothing usable came back.
 */
export async function ingestKb(llm: LLMClient, input: IngestInput): Promise<KbStoryDraft[]> {
  const text = input.text.trim();
  if (!text) return [];
  const companies = input.companies ?? [];
  const prompt = renderPrompt("kb_ingest", {
    never_claim: "(список пуст)",
    tag: input.tag,
    text,
    companies: companies.map((c) => `- ${c}`).join("\n"),
  });
  const raw = KbIngestSchema.parse(await llm.json<unknown>("kb_ingest", "write", prompt, INGEST_SCHEMA));
  const allowedNumbers = allowedIn(`${text} ${companies.join(" ")} ${input.tag}`);
  return raw.stories
    .map((s) => guardStory(s, { allowedNumbers, never: [] }))
    .filter((s): s is KbStoryDraft => !!s)
    .slice(0, MAX_INGEST_STORIES)
    .map((s) => ({ ...s, tags: s.tags.some((t) => tagKey(t) === tagKey(input.tag)) ? s.tags : [input.tag, ...s.tags] }));
}

/** Saves ingested stories (confirmed: the human wrote them) and marks the tag `yes`, then syncs the profile. */
export function saveIngested(store: Store, userId: number, tag: string, drafts: KbStoryDraft[], source: "telegram" | "panel" = "telegram"): KbStory[] {
  store.upsertKbTag(userId, { name: tag, status: "yes" });
  const { added } = addStories(store, userId, drafts, { source, confirmed: true });
  syncProfileSkills(store, userId);
  return added;
}
