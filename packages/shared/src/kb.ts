// Knowledge base (docs/ARCHITECTURE.md section 4): tags = skills with a yes/no/unknown status,
// stories = what the seeker actually did, linked to many tags. The only material texts may claim.

export type KbTagStatus = "yes" | "no" | "unknown";
export type KbStorySource = "seed" | "telegram" | "panel";

export interface KbTag {
  id: number;
  userId: number;
  name: string;
  aliases: string[];
  category: string;
  status: KbTagStatus;
  updatedAt: string;
  /** Stories linked to this tag. */
  storyCount: number;
}

export interface KbStory {
  id: number;
  userId: number;
  title: string;
  company: string;
  period: string;
  context: string;
  did: string;
  result: string;
  source: KbStorySource;
  confirmed: boolean;
  /** Content hash at first insert (kb/write.ts storyHash): re-seeding skips a story already present. */
  hash: string;
  createdAt: string;
  updatedAt: string;
  tags: { id: number; name: string }[];
}

/** upsertKbTag input: matched by name or alias (case-insensitive); aliases merge, status/category set when given. */
export interface NewKbTag {
  name: string;
  aliases?: string[];
  category?: string;
  status?: KbTagStatus;
}

/** Comparison key for tag names and aliases: «React.js » == «react.js», «Ёлка» == «елка». */
export const tagKey = (s: string): string => s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

/** True when `name` is this tag's name or one of its aliases. */
export const tagIs = (t: Pick<KbTag, "name" | "aliases">, name: string): boolean => {
  const k = tagKey(name);
  return !!k && (tagKey(t.name) === k || t.aliases.some((a) => tagKey(a) === k));
};

/** Aliases merged without duplicates and without the tag's own name. */
export const mergeAliases = (name: string, ...lists: string[][]): string[] => {
  const seen = new Set([tagKey(name)]);
  const out: string[] = [];
  for (const a of lists.flat()) {
    const k = tagKey(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a.trim());
  }
  return out;
};

export type NewKbStory = Omit<KbStory, "id" | "createdAt" | "updatedAt" | "tags"> & { tagIds: number[] };

export type KbReviewState = "pending" | "confirmed" | "expanded" | "denied" | "expired";

/** One topic of a chat reply task on the Telegram review card (docs/ARCHITECTURE.md section 4). */
export interface KbReview {
  id: number;
  userId: number;
  taskId: number | null;
  tagId: number;
  /** The topic as the task names it (may be an alias of the tag). */
  topic: string;
  state: KbReviewState;
  tgMessageId: string;
  /** The employer's question the topic came from. */
  prompt: string;
  /** «Дополнить» tapped: the Telegram chat whose next free text is the story; "" = not waiting. */
  awaitingChat: string;
  awaitingAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
