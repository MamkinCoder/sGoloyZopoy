// The one read path into the knowledge base for every consumer (chat drafts, letters, questionnaires, CVs):
// kbFor() picks the stories relevant to a set of tags and/or a free text within a char budget, renderKb()
// turns that into a prompt block. docs/ARCHITECTURE.md section 4.
import { companyKey, tagIs, tagKey, type KbBrief, type KbStory, type KbTag, type KbTagStatus, type Store, type Vacancy } from "@sgz/shared";
import { claimRegex, enforceMax, stripNeverClaimSentences } from "../llm/guards.js";

export interface KbQuery {
  /** Topic names (tag names or aliases), e.g. triage topics. */
  tags?: string[];
  /** Free text (a question, a vacancy): tags mentioned in it count as topics, its words rank stories. */
  text?: string;
}

export interface KbTopic {
  /** As asked; for tags found in the text, the tag's own name. */
  name: string;
  tag: KbTag | null;
  status: KbTagStatus;
  stories: number;
}

export interface KbContext {
  topics: KbTopic[];
  /** Best first, cut to the budget. */
  stories: KbStory[];
}

const TAG_WEIGHT = 10;
const TEXT_TAG_WEIGHT = 5;
const MIN_WORD = 4;

const words = (text: string): string[] => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}+#]+/gu) ?? []).filter((w) => w.length >= MIN_WORD))];

export function renderStory(s: KbStory): string {
  const head = [s.company, s.period].filter(Boolean).join(", ");
  return [
    `### ${s.title}${s.tags.length ? ` [${s.tags.map((t) => t.name).join(", ")}]` : ""}`,
    head,
    s.context && `Контекст: ${s.context}`,
    s.did && `Что сделал: ${s.did}`,
    s.result && `Результат: ${s.result}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function kbFor(store: Pick<Store, "listKbTags" | "listKbStories">, userId: number, q: KbQuery, budgetChars = 4000): KbContext {
  const tags = store.listKbTags(userId);
  const weight = new Map<number, number>();
  const topics: KbTopic[] = [];
  for (const name of q.tags ?? []) {
    const tag = tags.find((t) => tagIs(t, name)) ?? null;
    if (!name.trim() || topics.some((t) => (tag && t.tag?.id === tag.id) || tagKey(t.name) === tagKey(name))) continue;
    topics.push({ name: name.trim(), tag, status: tag?.status ?? "unknown", stories: tag?.storyCount ?? 0 });
    if (tag) weight.set(tag.id, TAG_WEIGHT);
  }
  const text = q.text ?? "";
  if (text.trim()) {
    for (const tag of tags) {
      if (weight.has(tag.id) || !claimRegex([tag.name, ...tag.aliases])?.test(text)) continue;
      weight.set(tag.id, TEXT_TAG_WEIGHT);
      topics.push({ name: tag.name, tag, status: tag.status, stories: tag.storyCount });
    }
  }
  const qWords = words(text);
  const any = weight.size > 0 || qWords.length > 0;

  const scored = store
    .listKbStories(userId)
    .map((s) => {
      const hay = `${s.title} ${s.context} ${s.did} ${s.result}`.toLowerCase();
      const base = s.tags.reduce((n, t) => n + (weight.get(t.id) ?? 0), 0) + qWords.filter((w) => hay.includes(w)).length;
      return { s, score: any && base === 0 ? 0 : base + (s.confirmed ? 1 : 0) + 0.5 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.s.id - a.s.id);

  const stories: KbStory[] = [];
  let used = 0;
  for (const { s } of scored) {
    // The best story always goes in, shortened when it alone is over the budget; a later one that doesn't fit
    // makes room for smaller ones below it.
    const story = stories.length ? s : fitStory(s, budgetChars);
    const n = renderStory(story).length + 2;
    if (stories.length && used + n > budgetChars) continue;
    stories.push(story);
    used += n;
  }
  return { topics, stories };
}

/** A story over the budget with its long fields cut at sentence boundaries (panel stories allow ~8k chars). */
function fitStory(s: KbStory, budgetChars: number): KbStory {
  if (renderStory(s).length + 2 <= budgetChars) return s;
  const max = Math.max(100, Math.floor(budgetChars / 4));
  return { ...s, context: enforceMax(s.context, max), did: enforceMax(s.did, max), result: enforceMax(s.result, max) };
}

const STATUS_LINE: Record<KbTagStatus, string> = {
  yes: "есть опыт",
  no: "нет в опыте, не заявлять",
  unknown: "не подтверждено",
};

/** Prompt block: the topic statuses, then the stories (the only material about experience). */
export function renderKb(ctx: KbContext): string {
  const topics = ctx.topics.map((t) => `- ${t.name}: ${t.tag ? STATUS_LINE[t.status] : "нет в базе"}${t.stories ? ` (историй: ${t.stories})` : ""}`);
  return [
    topics.length ? `Навыки по теме:\n${topics.join("\n")}` : "",
    ctx.stories.length ? `Истории из опыта (единственный материал об опыте):\n\n${ctx.stories.map(renderStory).join("\n\n")}` : "Историй по теме нет.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---- Application material (letters, questionnaires, CVs, prep): docs/ARCHITECTURE.md section 4 "Consumers".

/** Keeps Pi prompts fast: about a page of stories per generated text. */
export const KB_BRIEF_BUDGET = 3000;

export interface KbBriefQuery extends KbQuery {
  /** Only stories of these companies (tailor_cv: the base CV's jobs), matched by companyKey, either way contained. */
  companies?: string[];
  /** A chat task's own answers (human or 12 h fallback): the topic shows this status, and a «no» leaves the stories
   *  and joins `no` exactly like a status-`no` tag, even while the tag itself is still unknown. */
  overrides?: { name: string; status: "yes" | "no" }[];
}

type KbStore = Pick<Store, "listKbTags" | "listKbStories">;

const sameCompany = (a: string, b: string): boolean => {
  const x = companyKey(a);
  const y = companyKey(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

/** Stories without the status-`no` tags (plus `extraNo` names, e.g. a chat task's fallback «нет»): off the tag
 * lists, sentences naming them (name or alias) out, a title naming one drops the story. `no` = those names + aliases. */
export function withoutNo(tags: KbTag[], stories: KbStory[], extraNo: string[] = []): { stories: KbStory[]; no: string[] } {
  const noTags = tags.filter((t) => t.status === "no" || extraNo.some((n) => tagIs(t, n)));
  const noIds = new Set(noTags.map((t) => t.id));
  const no = [...new Map([...extraNo, ...noTags.flatMap((t) => [t.name, ...t.aliases])].map((n) => [tagKey(n), n.trim()])).values()].filter(Boolean);
  const noRe = claimRegex(no);
  const clean = (s: string) => stripNeverClaimSentences(s, no);
  return {
    no,
    stories: stories
      .filter((s) => !noRe?.test(s.title))
      .map((s) => ({ ...s, tags: s.tags.filter((t) => !noIds.has(t.id)), context: clean(s.context), did: clean(s.did), result: clean(s.result) })),
  };
}

/** KB block for an application text or a chat reply. Status-`no` tags never reach it: they leave story tag lists,
 * sentences naming them leave the stories (a title naming one drops the story), and they come back in `no` for
 * the guards. Their topic line stays only when asked (`q.tags`: the employer's question needs the honest «не
 * заявлять»). undefined for an empty KB, and when the KB can't be read: a KB problem never blocks an application. */
export function kbBrief(store: KbStore, userId: number, q: KbBriefQuery, budgetChars = KB_BRIEF_BUDGET): KbBrief | undefined {
  try {
    const tags = store.listKbTags(userId);
    const said = (t: KbTopic) => q.overrides?.find((o) => tagKey(o.name) === tagKey(t.name) || (!!t.tag && tagIs(t.tag, o.name)))?.status;
    const extraNo = (q.overrides ?? []).filter((o) => o.status === "no").map((o) => o.name);
    const { no, stories: all } = withoutNo(tags, store.listKbStories(userId), extraNo);
    const stories = all.filter((s) => !q.companies || q.companies.some((c) => sameCompany(c, s.company)));
    if (!tags.length && !stories.length && !no.length) return undefined;
    const ctx = kbFor({ listKbTags: () => tags, listKbStories: () => stories }, userId, q, budgetChars);
    const asked = (t: KbTopic) => !!q.tags?.some((n) => tagKey(n) === tagKey(t.name));
    const topics = ctx.topics.map((t) => ({ ...t, status: said(t) ?? t.status })).filter((t) => t.status !== "no" || asked(t));
    return { text: topics.length || ctx.stories.length ? renderKb({ topics, stories: ctx.stories }) : "", no };
  } catch {
    return undefined;
  }
}

const vacancyText = (v: Vacancy): string => `${v.title}\n${v.descriptionText}`;

/** kbBrief for one or more vacancies (a decide batch), plus optional extra text (questionnaire questions, an invitation). */
export function kbForVacancy(store: KbStore, userId: number, vacancies: Vacancy | Vacancy[] | null, extra = "", budgetChars = KB_BRIEF_BUDGET): KbBrief | undefined {
  const vs = vacancies === null ? [] : Array.isArray(vacancies) ? vacancies : [vacancies];
  return kbBrief(store, userId, { text: [...vs.map(vacancyText), extra].filter(Boolean).join("\n\n") }, budgetChars);
}

/** Profile whose never_claim_skills also carries the KB's status-`no` tags, so every existing guard (blockedTech,
 * stripNeverClaimSentences, guardTailoredCV, validateCV, guardStudy) enforces them too. */
export function withKbNever<P extends { never_claim_skills: string[] }>(profile: P, kb: KbBrief | undefined): P {
  if (!kb?.no.length) return profile;
  const have = new Set(profile.never_claim_skills.map(tagKey));
  const add = kb.no.filter((n) => !have.has(tagKey(n)) && !!have.add(tagKey(n)));
  return add.length ? { ...profile, never_claim_skills: [...profile.never_claim_skills, ...add] } : profile;
}
