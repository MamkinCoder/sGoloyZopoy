import type { ChatMessage, ChatThread, InterviewPrep, Store } from "@sgz/shared";
import { bool, jsonObjOrNull, num, numOrNull, placeholders, str, strOrNull, toJson, type Row, type Sql, nowISO } from "./sql.js";

export const mapThread = (r: Row): ChatThread => ({
  id: num(r.id),
  userId: num(r.user_id),
  hhNegotiationId: str(r.hh_negotiation_id),
  isBot: bool(r.is_bot),
  vacancyId: numOrNull(r.vacancy_id),
  employer: str(r.employer),
  state: str(r.state) as ChatThread["state"],
  lastSeenAt: str(r.last_seen_at),
  interviewAt: strOrNull(r.interview_at),
  prep: jsonObjOrNull<InterviewPrep>(r.prep_json),
});

export const mapMessage = (r: Row): ChatMessage => ({
  id: num(r.id),
  threadId: num(r.thread_id),
  hhMessageId: strOrNull(r.hh_message_id),
  direction: str(r.direction) as ChatMessage["direction"],
  author: str(r.author) as ChatMessage["author"],
  text: str(r.text),
  isQuestion: bool(r.is_question),
  answered: bool(r.answered),
  createdAt: str(r.created_at),
});

type ChatsRepo = Pick<
  Store,
  | "upsertChatThread"
  | "listChatThreads"
  | "insertChatMessages"
  | "listChatMessages"
  | "markAnswered"
  | "setChatInterview"
  | "setChatPrep"
  | "claimInterviewReminders"
>;

export function chatsRepo(s: Sql): ChatsRepo {
  return {
    upsertChatThread(t) {
      const lastSeen = t.lastSeenAt || nowISO();
      if (t.id !== undefined) {
        const { changes } = s.run(
          `UPDATE chat_threads SET user_id=?, hh_negotiation_id=?, is_bot=?, vacancy_id=?, employer=?, state=?,
             last_seen_at=? WHERE id=?`,
          t.userId,
          t.hhNegotiationId,
          t.isBot,
          t.vacancyId,
          t.employer,
          t.state,
          lastSeen,
          t.id,
        );
        if (!changes) throw new Error(`chat thread ${t.id} not found`);
        return mapThread(s.get("SELECT * FROM chat_threads WHERE id = ?", t.id) as Row);
      }
      const r = s.get(
        `INSERT INTO chat_threads (user_id, hh_negotiation_id, is_bot, vacancy_id, employer, state, last_seen_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(hh_negotiation_id) DO UPDATE SET user_id=excluded.user_id, is_bot=excluded.is_bot,
           vacancy_id=COALESCE(excluded.vacancy_id, chat_threads.vacancy_id),
           employer=CASE WHEN excluded.employer='' THEN chat_threads.employer ELSE excluded.employer END,
           state=excluded.state, last_seen_at=excluded.last_seen_at
         RETURNING *`,
        t.userId,
        t.hhNegotiationId,
        t.isBot,
        t.vacancyId,
        t.employer,
        t.state,
        lastSeen,
      );
      return mapThread(r as Row);
    },
    listChatThreads(userId, state) {
      const rows = state
        ? s.all(
            "SELECT * FROM chat_threads WHERE user_id = ? AND state = ? ORDER BY last_seen_at DESC, id DESC",
            userId,
            state,
          )
        : s.all("SELECT * FROM chat_threads WHERE user_id = ? ORDER BY last_seen_at DESC, id DESC", userId);
      return rows.map(mapThread);
    },
    insertChatMessages(threadId, msgs) {
      return s.transaction(() => {
        let inserted = 0;
        for (const m of msgs) {
          const hhId = m.hhMessageId || null;
          if (hhId === null) {
            const dup = s.get(
              "SELECT 1 AS x FROM chat_messages WHERE thread_id = ? AND direction = ? AND text = ? LIMIT 1",
              threadId,
              m.direction,
              m.text,
            );
            if (dup) continue;
          } else if (m.direction === "out") {
            // Our own reply read back from hh: the bot already stored it (without an hh id, which is what marks
            // bot replies in analytics), so the hh copy would only show up twice in the panel.
            const local = s.get(
              "SELECT 1 AS x FROM chat_messages WHERE thread_id = ? AND direction = 'out' AND hh_message_id IS NULL AND trim(text) = trim(?) LIMIT 1",
              threadId,
              m.text,
            );
            if (local) continue;
          }
          // ux_chat_messages_hh (thread_id, hh_message_id) makes OR IGNORE skip known hh ids.
          const { changes } = s.run(
            `INSERT OR IGNORE INTO chat_messages (thread_id, hh_message_id, direction, author, text, is_question,
               answered, created_at) VALUES (?,?,?,?,?,?,?,?)`,
            threadId,
            hhId,
            m.direction,
            m.author,
            m.text,
            m.isQuestion,
            m.answered,
            nowISO(),
          );
          inserted += changes;
        }
        return inserted;
      });
    },
    listChatMessages(threadId) {
      return s.all("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id", threadId).map(mapMessage);
    },
    markAnswered(messageIds) {
      if (messageIds.length === 0) return;
      s.run(`UPDATE chat_messages SET answered = 1 WHERE id IN (${placeholders(messageIds.length)})`, ...messageIds);
    },
    setChatInterview(threadId, atISO) {
      // Same time again (the LLM re-reads the whole chat) keeps the sent flag; a new time re-arms the reminder.
      s.run(
        "UPDATE chat_threads SET interview_reminded = CASE WHEN interview_at IS ? THEN interview_reminded ELSE 0 END, interview_at = ? WHERE id = ?",
        atISO,
        atISO,
        threadId,
      );
    },
    setChatPrep(threadId, prep) {
      s.run("UPDATE chat_threads SET prep_json = ? WHERE id = ?", toJson(prep), threadId);
    },
    claimInterviewReminders(nowISO, untilISO) {
      return s.transaction(() => {
        const rows = s.all(
          "SELECT * FROM chat_threads WHERE interview_reminded = 0 AND interview_at > ? AND interview_at <= ? ORDER BY interview_at",
          nowISO,
          untilISO,
        );
        for (const r of rows) s.run("UPDATE chat_threads SET interview_reminded = 1 WHERE id = ?", r.id);
        return rows.map(mapThread);
      });
    },
  };
}
