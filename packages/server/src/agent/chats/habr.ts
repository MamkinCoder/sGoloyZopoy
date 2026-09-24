// chats.sync, Habr Career part. Conversations are person-to-person (a recruiter writes after a response or on
// their own). A thread the employer started gets a reply task like hh; a thread the seeker started (e.g. a
// referral ask) is never answered by the bot: new incoming messages there only go to Telegram. Invitations
// and Habr's own «вы договорились о работе?» survey are handled here too.
import type { ChatMessage, User } from "@sgz/shared";
import { conversationUrl } from "../../habr/state.js";
import { asksQuestion } from "../../hh/state.js";
import { errMessage } from "../../runner/util.js";
import type { ChatEnv } from "./env.js";
import { CHAT_TRACK_SINCE_DEFAULT } from "./hh.js";
import { closeTask, reconcileThread, unansweredIds } from "./tasks.js";

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
    // Known thread, its last message already stored or ours (our replies are stored without Habr's id), nothing pending.
    if (prev && (lm.isMine || stored.some((m) => m.hhMessageId === lm.id)) && !unansweredIds(stored).length) continue;
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
      env.store.insertChatMessages(
        thread.id,
        detail.messages.map((m) => ({ hhMessageId: m.id, direction: m.mine ? ("out" as const) : ("in" as const), author: m.mine ? ("me" as const) : ("employer" as const), text: m.text, isQuestion: !m.mine && asksQuestion(m.text), answered: false })),
      );
      // Habr's own «вы договорились о работе?» survey (kind question) is not the employer talking: only it is
      // handled, a recruiter question before it still gets its reply.
      if (lm.kind === "question") {
        const all = env.store.listChatMessages(thread.id);
        const survey = all.find((m) => m.hhMessageId === lm.id) ?? all.at(-1);
        if (survey?.direction === "in" && !survey.answered) env.store.markAnswered([survey.id]);
      }
      const history = env.store.listChatMessages(thread.id);
      const fresh = history.filter((m) => m.direction === "in" && !m.answered);
      const handled = (why: string) => {
        const open = env.store.openChatTask(thread.id);
        if (open && open.state !== "sending") closeTask(env, open, why);
        env.store.markAnswered(unansweredIds(env.store.listChatMessages(thread.id)));
      };
      if (invited && prev?.state !== "invited") {
        await env.notifier.alert(`🎉 Приглашение на Хабр Карьере: ${employer}`, `${user.name}: ${fresh.at(-1)?.text.slice(0, 800) ?? lm.text.slice(0, 800)}\n${url}`).catch(() => undefined);
      }
      if (!fresh.length || history.at(-1)?.direction === "out") {
        handled("ответ не нужен");
        continue;
      }
      if (history[0]?.direction === "out") {
        await env.notifier.alert(`Хабр Карьера: сообщение от ${employer}`, `${user.name}: ${fresh.map((m) => m.text).join("\n\n").slice(0, 1500)}\n${url}`).catch(() => undefined);
        handled("переписку начал соискатель: переслано в Telegram");
        continue;
      }
      if (!detail.writable) {
        handled("чат закрыт для сообщений");
        continue;
      }
      reconcileThread(env, thread, c.login);
    } catch (e) {
      env.log.error("chats", `habr ${employer}: ${errMessage(e)}`, { login: c.login });
    }
  }
}
