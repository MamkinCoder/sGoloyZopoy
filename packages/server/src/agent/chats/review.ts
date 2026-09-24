// Review gate: before a reply is drafted, every skill the employer asked about must be resolved. The chat task
// state machine (tasks.ts) only talks to the ReviewGate interface. The gate is the knowledge-base review
// (docs/ARCHITECTURE.md §3 step 3, §4): every task topic resolves to a KB tag (alias-aware), one Telegram card per
// task lists the topics with their stories and per-topic buttons «Подтвердить» / «Дополнить» / «Нет навыка»,
// one kb_reviews row per shown topic. «Дополнить» asks for a story; the next free text in that chat is ingested
// by the `kb.ingest` job. Setting kb_review_mode: always (default) | new_only | off.
import { tagIs, type ChatTask, type ChatTopic, type KbReview, type KbStory, type KbTag, type KbTagStatus, type Notifier, type TapReply, type TgButton } from "@sgz/shared";
import { ingestKb, saveIngested } from "../../kb/llm.js";
import { syncProfileSkills } from "../../kb/write.js";
import { escapeHtml } from "../../notify/format.js";
import type { ChatEnv, ChatStore } from "./env.js";
import { answerTopic, READY_FOOTER, stateFooter } from "./tasks.js";

export interface ReviewGate {
  /** The task's topics with everything already known filled in; `answer: null` = the human must say. */
  prefill(task: ChatTask): ChatTopic[];
  /** Shows the pending topics to the human (one card); resolves to the Telegram message id when known. */
  ask(task: ChatTask, reminder: boolean): Promise<number | null>;
  /** Keeps a human yes/no beyond this task (the KB tag status) and resolves the task's review of that topic. */
  record(userId: number, topic: string, has: boolean, taskId?: number): void;
  /** The card for the task as it is now (after a tap it replaces the tapped message). */
  card(task: ChatTask, footer?: string): Omit<TapReply, "note">;
  /** How many stories per topic the task's card shows now (fewer when the card would not fit). */
  storiesShown(task: ChatTask): number;
  /** The task stopped waiting (12 h fallback): its open reviews expire. */
  expire(taskId: number): void;
}

/** c = Подтвердить, e = Дополнить, d = Нет навыка. */
export type KbAction = "c" | "e" | "d";
export const kbCallback = (reviewId: number, a: KbAction): string => `kr:${reviewId}:${a}`;
export function parseKbCallback(data: string): { reviewId: number; action: KbAction } | null {
  const m = /^kr:(\d+):([ced])$/.exec(data);
  return m ? { reviewId: Number(m[1]), action: m[2] as KbAction } : null;
}

export type KbReviewMode = "always" | "new_only" | "off";
export const KB_REVIEW_MODES: readonly KbReviewMode[] = ["always", "new_only", "off"];
export const kbReviewMode = (store: Pick<ChatStore, "getSetting">): KbReviewMode => {
  const v = store.getSetting("kb_review_mode") as KbReviewMode | null;
  return v && KB_REVIEW_MODES.includes(v) ? v : "always";
};

export const askStoryText = (topic: string): string => `Напиши, что ты делал с ${topic}: где, что именно, какой результат.`;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** Telegram's limit is 4096; a reminder prefix goes in front of the card. */
const CARD_MAX = 3900;
const STORIES_PER_TOPIC = 3;

/** The topic's KB tag; a topic the KB does not know becomes a tag (yes/no when the profile lists it, else unknown). */
export function topicTag(store: ChatStore, userId: number, name: string): KbTag {
  const hit = store.listKbTags(userId).find((t) => tagIs(t, name));
  if (hit) return hit;
  const p = store.getProfile(userId);
  const listed = (list: string[] | undefined) => !!list?.some((s) => tagIs({ name, aliases: [] }, s));
  const status: KbTagStatus = listed(p?.never_claim_skills) ? "no" : listed(p?.verified_skills) ? "yes" : "unknown";
  return store.upsertKbTag(userId, { name: name.trim(), status });
}

function storyLine(s: KbStory): string {
  const what = [s.did && cut(s.did, 110), s.result && `итог: ${cut(s.result, 80)}`].filter(Boolean).join("; ");
  return `  • ${escapeHtml(cut(s.title, 80))}${s.company ? ` (${escapeHtml(s.company)})` : ""}${what ? `: ${escapeHtml(what)}` : ""}`;
}

interface TopicView {
  tp: ChatTopic;
  review: KbReview | undefined;
  tag: KbTag | null;
  stories: KbStory[];
}

function topicLines(v: TopicView, max: number): string {
  const head = `<b>${escapeHtml(v.tp.name)}</b>`;
  const { tp, review } = v;
  if (tp.answer === null) {
    if (review?.awaitingChat) return `${head}: ✍️ жду твой рассказ`;
    if (!v.stories.length) return `${head}: историй нет${v.tag?.status === "yes" ? ", навык отмечен" : ""}`;
    const more = v.stories.length > max ? ` (показаны ${max})` : "";
    return [`${head}: историй ${v.stories.length}${max ? more : ""}`, ...v.stories.slice(0, max).map(storyLine)].join("\n");
  }
  if (tp.by === "fallback") return `${head}: ⏳ без ответа, в этом ответе не заявляю`;
  if (tp.by === "profile") return `${head}: ${tp.answer === "yes" ? "✅ есть в базе" : "❌ нет в базе, не заявляю"}`;
  if (review?.state === "expanded") return `${head}: ✍️ дополнено, история сохранена`;
  return `${head}: ${tp.answer === "yes" ? "✅ подтверждено" : "❌ нет навыка"}`;
}

export function kbReviewGate(store: ChatStore, notifier: Pick<Notifier, "ask" | "alert">, now: () => Date = () => new Date()): ReviewGate {
  const iso = () => now().toISOString();
  const thread = (task: ChatTask) => store.listChatThreads(task.userId).find((t) => t.id === task.threadId) ?? null;
  const asked = (task: ChatTask) =>
    store
      .listChatMessages(task.threadId)
      .filter((m) => task.messageIds.includes(m.id))
      .map((m) => m.text.trim())
      .join("\n")
      .slice(0, 600);

  const render = (task: ChatTask, footer?: string) => {
    const reviews = store.listKbReviews(task.id);
    const tags = store.listKbTags(task.userId);
    const views: TopicView[] = task.topics.map((tp) => {
      const review = reviews.find((r) => same(r.topic, tp.name));
      const tag = (review && tags.find((t) => t.id === review.tagId)) ?? tags.find((t) => tagIs(t, tp.name)) ?? null;
      return { tp, review, tag, stories: tag && tp.answer === null ? store.listKbStories(task.userId, tag.id) : [] };
    });
    const pending = views.filter((v): v is TopicView & { review: KbReview } => v.tp.answer === null && !!v.review);
    const buttons: TgButton[][] = pending.map(({ tp, review, tag, stories }) => [
      // Nothing to cite = nothing to confirm: a bare «да» is worthless to the employer, so ask for a story instead.
      ...(stories.length ? [{ text: `Подтвердить ${tp.name}`, data: kbCallback(review.id, "c") }] : []),
      { text: `Дополнить ${tp.name}`, data: kbCallback(review.id, "e") },
      { text: `Нет навыка ${tp.name}`, data: kbCallback(review.id, "d") },
    ]);
    const tail = footer ?? (pending.length ? "Подтверди, дополни или отметь «Нет навыка» по каждой теме. Ответ работодателю уйдёт, когда ответишь на все." : READY_FOOTER);
    const head = `<b>${escapeHtml(thread(task)?.employer || "Работодатель")}</b> спрашивает:\n«${escapeHtml(asked(task))}»`;
    let text = "";
    let max = STORIES_PER_TOPIC;
    // Fewer stories per topic until the card fits one Telegram message (6 topics without stories always fit).
    for (; max >= 0; max--) {
      text = `${head}\n\n${views.map((v) => topicLines(v, max)).join("\n")}\n\n${tail}`;
      if (text.length <= CARD_MAX) break;
    }
    return { text, buttons, max: Math.max(max, 0) };
  };
  const card: ReviewGate["card"] = (task, footer) => {
    const { text, buttons } = render(task, footer);
    return { text, buttons };
  };

  /** One pending review per unanswered topic (idempotent: a reminder or a second ask reuses the rows). */
  const ensureReviews = (task: ChatTask) => {
    const have = store.listKbReviews(task.id);
    const prompt = asked(task);
    for (const tp of task.topics) {
      if (tp.answer !== null || have.some((r) => same(r.topic, tp.name))) continue;
      store.insertKbReview({ userId: task.userId, taskId: task.id, tagId: topicTag(store, task.userId, tp.name).id, topic: tp.name, prompt }, iso());
    }
  };

  return {
    prefill(task) {
      const mode = kbReviewMode(store);
      return task.topics.map((tp): ChatTopic => {
        if (tp.answer) return tp;
        const tag = topicTag(store, task.userId, tp.name);
        if (mode === "off") return { ...tp, answer: tag.status === "yes" ? "yes" : "no", by: "profile" };
        // new_only: a topic with stories is not shown; a tag the human already denied is not asked again. Unconfirmed
        // seed stories of a tag nobody confirmed are not proof: the human is asked.
        if (mode === "new_only" && tag.status === "no") return { ...tp, answer: "no", by: "profile" };
        if (mode === "new_only" && tag.storyCount > 0 && (tag.status === "yes" || store.listKbStories(task.userId, tag.id).some((s) => s.confirmed)))
          return { ...tp, answer: "yes", by: "profile" };
        return tp;
      });
    },
    async ask(task, reminder) {
      ensureReviews(task);
      if (!notifier.ask) {
        // No Telegram buttons (no token): the 12 h fallback answers honestly without the human.
        await notifier.alert("Навыки ждут ответа", `${thread(task)?.employer ?? ""}: ${task.topics.filter((t) => !t.answer).map((t) => t.name).join(", ")}`).catch(() => undefined);
        return null;
      }
      const c = card(task);
      const id = await notifier.ask(reminder ? `⏰ Напоминание: работодатель ждёт ответа уже 2 часа\n\n${c.text}` : c.text, c.buttons);
      if (typeof id !== "number") return null;
      store.setKbReviewMessage(task.id, String(id));
      return id;
    },
    record(userId, topic, has, taskId) {
      const tag = topicTag(store, userId, topic);
      store.setKbTagStatus(tag.id, has ? "yes" : "no");
      syncProfileSkills(store, userId);
      if (taskId === undefined) return;
      for (const r of store.listKbReviews(taskId)) if (r.tagId === tag.id) store.resolveKbReview(r.id, has ? "confirmed" : "denied", iso());
    },
    card,
    storiesShown: (task) => render(task).max,
    expire(taskId) {
      for (const r of store.listKbReviews(taskId)) store.resolveKbReview(r.id, "expired", iso());
    },
  };
}

// ------------------------------------------------------------ taps, free text, kb.ingest

const iso = (env: ChatEnv) => env.now().toISOString();

/**
 * Where a review's answer goes: its own task while that waits; after the employer wrote again, the thread's open
 * task still waiting for the same tag. Null when nothing waits for it any more.
 */
function liveTarget(env: ChatEnv, review: KbReview): { task: ChatTask; review: KbReview } | null {
  const own = review.taskId === null ? null : env.store.getChatTask(review.taskId);
  if (!own) return null;
  if (own.state === "awaiting_review") return review.state === "pending" && own.topics.some((t) => same(t.name, review.topic) && t.answer === null) ? { task: own, review } : null;
  if (review.state !== "pending" && review.state !== "expired") return null;
  const open = env.store.openChatTask(own.threadId);
  if (open?.state !== "awaiting_review") return null;
  const r = env.store.listKbReviews(open.id).find((x) => x.tagId === review.tagId && x.state === "pending");
  if (!r || !open.topics.some((t) => same(t.name, r.topic) && t.answer === null)) return null;
  return { task: open, review: r };
}

/** «Подтвердить» confirms the stories the card showed, never ones cut to fit the card. */
function confirmStories(env: ChatEnv, task: ChatTask, tagId: number): void {
  for (const s of env.store.listKbStories(task.userId, tagId).slice(0, env.review.storiesShown(task))) {
    if (!s.confirmed) env.store.saveKbStory({ ...s, confirmed: true, tagIds: s.tags.map((t) => t.id) });
  }
}

/** A button of the KB card. `chatId`: where it was tapped («Дополнить» waits for the next text there). */
export function onKbTap(env: ChatEnv, tap: { reviewId: number; action: KbAction }, chatId: string): TapReply | string {
  const review = env.store.getKbReview(tap.reviewId);
  const own = review?.taskId != null ? env.store.getChatTask(review.taskId) : null;
  if (!review || !own) return "эта карточка уже неактуальна";
  const live = liveTarget(env, review);
  if (!live) return { note: "уже учтено", ...env.review.card(own, own.state === "awaiting_review" ? undefined : stateFooter(own)) };
  const { task, review: r } = live;
  if (r.id !== review.id) env.store.resolveKbReview(review.id, "expired", iso(env)); // an old card: its review is replaced
  if (tap.action === "e") {
    const first = env.store.awaitingKbReviews(chatId)[0];
    env.store.awaitKbReviewText(r.id, chatId, iso(env));
    const c = env.review.card(task);
    if (first && first.id !== r.id) return { note: `Спрошу про ${r.topic} после ответа про ${first.topic}`, ...c };
    return { note: `Жду рассказ про ${r.topic}`, ...c, say: escapeHtml(askStoryText(r.topic)) };
  }
  if (tap.action === "c") confirmStories(env, task, r.tagId);
  const done = answerTopic(env, task, r.topic, tap.action === "c");
  if (!done) return { note: "уже учтено", ...env.review.card(own, stateFooter(own)) };
  return { note: tap.action === "c" ? `✅ ${r.topic}` : `❌ ${r.topic}: нет навыка`, ...env.review.card(done, done.state === "awaiting_review" ? undefined : READY_FOOTER) };
}

/**
 * A free-text Telegram message: when a review in this chat waits for a story, the text is its answer (kb.ingest
 * job) and the next waiting review is asked. Null = not for the KB (other handlers, e.g. /mock answers, go next).
 */
export function kbText(env: ChatEnv, chatId: string, text: string): string | null {
  if (!text.trim()) return null;
  // A wait whose topic nothing waits for any more (task closed, failed, answered) is dropped, not fed.
  const waiting = env.store.awaitingKbReviews(chatId).filter((x) => liveTarget(env, x) !== null || (env.store.awaitKbReviewText(x.id, "", iso(env)), false));
  const [r, next] = waiting;
  if (!r) return null;
  env.store.awaitKbReviewText(r.id, "", iso(env));
  // No key: a second story for the same topic while the first still waits for an LLM slot is its own job.
  env.enqueue("kb.ingest", { reviewId: r.id, text });
  return `Принял, записываю историю про ${r.topic}.${next ? `\n\n${askStoryText(next.topic)}` : ""}`;
}

/** The review's card again as it is now (its «✍️ жду» line back to buttons after a failed ingest). */
async function refreshCard(env: ChatEnv, review: KbReview): Promise<void> {
  const task = liveTarget(env, review)?.task ?? (review.taskId === null ? null : env.store.getChatTask(review.taskId));
  if (task?.tgMessageId == null) return;
  const c = env.review.card(task, task.state === "awaiting_review" ? undefined : stateFooter(task));
  await env.notifier.edit?.(task.tgMessageId, c.text, c.buttons).catch(() => undefined);
}

/** kb.ingest gave up (LLM down): say so per topic and show the card's buttons again. */
export async function ingestFailed(env: ChatEnv, reviewId: number): Promise<void> {
  const review = env.store.getKbReview(reviewId);
  if (!review) return;
  await env.notifier.alert("Не записал историю", `Не получилось записать историю про ${review.topic}. Нажми «Дополнить» ещё раз и пришли её снова.`).catch(() => undefined);
  await refreshCard(env, review);
}

/** kb.ingest (llm): the story -> KB (tag yes), the review `expanded`, the topic answered, the card edited. */
export async function ingestReview(env: ChatEnv, reviewId: number, text: string): Promise<void> {
  const first = env.store.getKbReview(reviewId);
  if (!first || first.state === "denied") return;
  const tag = env.store.listKbTags(first.userId).find((t) => t.id === first.tagId);
  if (!tag) return;
  const companies = [...new Set(env.store.listKbStories(first.userId).map((s) => [s.company, s.period].filter(Boolean).join(", ")).filter(Boolean))];
  const drafts = await ingestKb(env.llm, { tag: tag.name, text, companies });
  // Re-read after the LLM: «Нет навыка» tapped meanwhile is the human's last word, the tag stays «no».
  const review = env.store.getKbReview(reviewId);
  if (!review || review.state === "denied") return;
  if (!drafts.length) {
    await env.notifier.ask?.(`Не получилось собрать историю про <b>${escapeHtml(tag.name)}</b> из этого текста. Нажми «Дополнить» ещё раз и напиши подробнее: где, что делал, какой результат.`, []).catch(() => undefined);
    await refreshCard(env, review);
    return;
  }
  saveIngested(env.store, review.userId, tag.name, drafts);
  if (review.state === "expanded" || review.state === "confirmed") return; // one more story for an answered topic: saved
  const live = liveTarget(env, review);
  env.store.resolveKbReview(review.id, "expanded", iso(env));
  if (!live) return; // the task moved on (fallback, answered by hand): the story is kept anyway
  env.store.resolveKbReview(live.review.id, "expanded", iso(env));
  const done = answerTopic(env, live.task, live.review.topic, true);
  if (done?.tgMessageId != null) {
    const c = env.review.card(done, done.state === "awaiting_review" ? undefined : READY_FOOTER);
    await env.notifier.edit?.(done.tgMessageId, c.text, c.buttons).catch(() => undefined);
  }
}
