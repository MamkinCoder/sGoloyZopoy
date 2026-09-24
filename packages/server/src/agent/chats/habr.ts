// chats.sync, Habr Career part. Conversations are person-to-person (a recruiter writes after a response or on
// their own). A thread the employer started gets a reply task like hh; a thread the seeker started (e.g. a
// referral ask) is never answered by the bot: new incoming messages there only go to Telegram. Invitations
// and Habr's own «вы договорились о работе?» survey are handled here too.
import type { ChatMessage, User } from "@sgz/shared";
import { conversationUrl } from "../../habr/state.js";
import { errMessage } from "../../runner/util.js";
import type { ChatEnv } from "./env.js";
import { CHAT_TRACK_SINCE_DEFAULT } from "./hh.js";
import { habrPageMessage, reconcileThread, settleThread, unansweredIds } from "./tasks.js";

/** Chat threads of Habr conversations live next to hh ones, keyed "habr:<login>". */
export const habrThreadKey = (login: string): string => `habr:${login}`;

export async function syncHabrChats(env: ChatEnv, user: User): Promise<void> {
  const habr = env.habr;
  if (!habr) return;
  const s = await env.browser.openHabr(user);
  const { conversations } = await habr.listConversations(s);
  const known = new Map(env.store.listChatThreads(user.id).filter((t) => t.hhNegotiationId.startsWith("habr:")).map((t) => [t.hhNegotiationId, t]));
  const sinceDay = env.store.getSetting("chat_track_since") || CHAT_TRACK_SINCE_DEFAULT;
  for (const c of conversations) {
    const lm = c.lastMessage;
    if (!lm) continue;
    const key = habrThreadKey(c.login);
    const prev = known.get(key);
    const stored: ChatMessage[] = prev ? env.store.listChatMessages(prev.id) : [];
    if (!prev && (lm.isMine || lm.createdAt.slice(0, 10) < sinceDay)) continue;
    // Known thread, its last message already stored, seen (a system card such as the survey is not in the page's
    // messages) or ours (our replies are stored without Habr's id), nothing pending.
    const seenKey = `habr_last_seen:${key}`;
    const seen = lm.isMine || stored.some((m) => m.hhMessageId === lm.id) || env.store.getSetting(seenKey) === lm.id;
    if (prev && seen && !unansweredIds(stored).length) continue;
    const employer = c.company ? `${c.company} (${c.name})` : c.name;
    const url = conversationUrl(c.login);
    try {
      const detail = await habr.readConversation(s, c.login);
      const invited = /invit/i.test(lm.kind);
      const thread = env.store.upsertChatThread({
        userId: user.id,
        hhNegotiationId: key,
        isBot: false,
        vacancyId: prev?.vacancyId ?? null,
        employer,
        state: invited ? "invited" : (prev?.state ?? "new"),
        lastSeenAt: env.now().toISOString(),
        ...(prev ? { id: prev.id } : {}),
      });
      env.store.insertChatMessages(thread.id, detail.messages.map(habrPageMessage));
      env.store.setSetting(seenKey, lm.id);
      // Habr's own «вы договорились о работе?» survey (kind question) is not the employer talking: only that
      // message needs no reply, a recruiter's question before it still does.
      if (lm.kind === "question") env.store.markAnswered(env.store.listChatMessages(thread.id).filter((m) => m.hhMessageId === lm.id).map((m) => m.id));
      const history = env.store.listChatMessages(thread.id);
      const fresh = history.filter((m) => m.direction === "in" && !m.answered);
      if (invited && prev?.state !== "invited") {
        await env.notifier.alert(`🎉 Приглашение на Хабр Карьере: ${employer}`, `${user.name}: ${fresh.at(-1)?.text.slice(0, 800) ?? lm.text.slice(0, 800)}\n${url}`).catch(() => undefined);
      }
      if (!fresh.length || history.at(-1)?.direction === "out") {
        settleThread(env, thread.id, "ответ не нужен");
        continue;
      }
      if (history[0]?.direction === "out") {
        await env.notifier.alert(`Хабр Карьера: сообщение от ${employer}`, `${user.name}: ${fresh.map((m) => m.text).join("\n\n").slice(0, 1500)}\n${url}`).catch(() => undefined);
        settleThread(env, thread.id, "переписку начал соискатель: переслано в Telegram");
        continue;
      }
      if (!detail.writable) {
        settleThread(env, thread.id, "чат закрыт для сообщений");
        continue;
      }
      reconcileThread(env, thread, c.login);
    } catch (e) {
      env.log.error("chats", `habr ${employer}: ${errMessage(e)}`, { login: c.login });
    }
  }
}
