// The one read path into the knowledge base for every consumer (chat drafts, letters, questionnaires, CVs):
// kbFor() picks the stories relevant to a set of tags and/or a free text within a char budget, renderKb()
// turns that into a prompt block. docs/ARCHITECTURE.md section 4.
import { tagIs, tagKey, type KbStory, type KbTag, type KbTagStatus, type Store } from "@sgz/shared";
import { claimRegex } from "../llm/guards.js";

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
    const n = renderStory(s).length + 2;
    if (stories.length && used + n > budgetChars) break;
    stories.push(s);
    used += n;
  }
  return { topics, stories };
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
