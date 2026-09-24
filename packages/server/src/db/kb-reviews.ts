// kb_reviews: one row per topic of a chat reply task shown on the Telegram review card (agent only, like chat_tasks).
import type { KbReview, KbReviewState } from "@sgz/shared";
import { num, numOrNull, str, strOrNull, type Row, type Sql } from "./sql.js";

const mapReview = (r: Row): KbReview => ({
  id: num(r.id),
  userId: num(r.user_id),
  taskId: numOrNull(r.task_id),
  tagId: num(r.tag_id),
  topic: str(r.topic),
  state: str(r.state) as KbReviewState,
  tgMessageId: str(r.tg_message_id),
  prompt: str(r.prompt),
  awaitingChat: str(r.awaiting_chat),
  awaitingAt: strOrNull(r.awaiting_at),
  createdAt: str(r.created_at),
  resolvedAt: strOrNull(r.resolved_at),
});

export interface KbReviewsRepo {
  insertKbReview(r: Pick<KbReview, "userId" | "taskId" | "tagId" | "topic" | "prompt">, nowISO: string): KbReview;
  getKbReview(id: number): KbReview | null;
  /** A task's reviews, oldest first. */
  listKbReviews(taskId: number): KbReview[];
  /** pending -> `to` (clears the awaiting mark); false when it was resolved already. */
  resolveKbReview(id: number, to: Exclude<KbReviewState, "pending">, nowISO: string): boolean;
  setKbReviewMessage(taskId: number, tgMessageId: string): void;
  /** Marks a pending review as waiting for free text in `chatId`, keeping the first waiting time; "" = done waiting. */
  awaitKbReviewText(id: number, chatId: string, nowISO: string): boolean;
  /** Pending reviews waiting for text in this chat, the one to answer first at [0]. */
  awaitingKbReviews(chatId: string): KbReview[];
}

export function kbReviewsRepo(s: Sql): KbReviewsRepo {
  const get = (id: number) => {
    const r = s.get("SELECT * FROM kb_reviews WHERE id = ?", id);
    return r ? mapReview(r) : null;
  };
  return {
    insertKbReview(r, nowISO) {
      const { lastId } = s.run("INSERT INTO kb_reviews (user_id, task_id, tag_id, topic, prompt, created_at) VALUES (?,?,?,?,?,?)", r.userId, r.taskId, r.tagId, r.topic, r.prompt, nowISO);
      return get(lastId)!;
    },
    getKbReview: get,
    listKbReviews(taskId) {
      return s.all("SELECT * FROM kb_reviews WHERE task_id = ? ORDER BY id", taskId).map(mapReview);
    },
    resolveKbReview(id, to, nowISO) {
      return s.run("UPDATE kb_reviews SET state = ?, resolved_at = ?, awaiting_chat = '' WHERE id = ? AND state = 'pending'", to, nowISO, id).changes > 0;
    },
    setKbReviewMessage(taskId, tgMessageId) {
      s.run("UPDATE kb_reviews SET tg_message_id = ? WHERE task_id = ?", tgMessageId, taskId);
    },
    awaitKbReviewText(id, chatId, nowISO) {
      if (!chatId) return s.run("UPDATE kb_reviews SET awaiting_chat = '', awaiting_at = NULL WHERE id = ?", id).changes > 0;
      return s.run("UPDATE kb_reviews SET awaiting_chat = ?, awaiting_at = COALESCE(awaiting_at, ?) WHERE id = ? AND state = 'pending'", chatId, nowISO, id).changes > 0;
    },
    awaitingKbReviews(chatId) {
      return s.all("SELECT * FROM kb_reviews WHERE awaiting_chat = ? AND state = 'pending' ORDER BY awaiting_at, id", chatId).map(mapReview);
    },
  };
}
