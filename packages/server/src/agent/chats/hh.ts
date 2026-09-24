// chats.sync, hh.ru part: read the chat list, store new messages, keep today's side effects (invitation
// alert + prep, rejection feedback request, feedback forwarding, bot surveys, follow-ups) and open a reply task
// for every thread with unanswered employer messages. Replies themselves are written by the task jobs.
import { OPEN_TASK_STATES, Status, type BrowserSession, type ChatMessage, type ChatThread, type ThreadRow, type User, type Vacancy } from "@sgz/shared";
import { mapNegotiationState } from "../../hh/state.js";
import { vacancyUrl } from "../../hh/urls.js";
import { followupChats } from "../../runner/interview.js";
import { ensureVacancy, skeletonVacancy } from "../../runner/filters.js";
import { alertWithStudy } from "../../runner/study.js";
import { errMessage } from "../../runner/util.js";
import type { ChatEnv } from "./env.js";
import { reconcileThread, settleThread } from "./tasks.js";
import { kbForVacancy } from "../../kb/context.js";
import { renderQuestions } from "../../llm/format.js";

export const CHAT_TRACK_SINCE_DEFAULT = "2026-09-23";
/** Chat list pages (20 chats each) read per sync, and chat-list-only chats opened per sync. */
export const CHAT_LIST_MAX_PAGES = 5;
export const CHAT_LIST_MAX_OPENS = 10;

/** Letters sent into chats per sync (letter guarantee, below); the rest wait for the next sync. */
export const LETTER_MAX_PER_SYNC = 5;
/** hh's own line on an application that went without a letter. */
const NO_LETTER = /без сопроводительного письма/i;
export const letterKey = (threadId: number) => `letter_followup:${threadId}`;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The letter of our SENT application behind this thread (applied since `since`), or "". */
function storedLetter(env: ChatEnv, thread: ChatThread, since: string): string {
  const app = thread.vacancyId === null ? null : env.store.lastApplication(thread.userId, thread.vacancyId);
  return app?.status === Status.SENT && app.createdAt >= since ? app.coverLetter.trim() : "";
}

/**
 * Letter guarantee: every hh application carries its cover letter. When the chat of our SENT application shows no
 * outgoing message with the stored letter (hh: «Без сопроводительного письма»), the employer has not written yet and
 * the chat is writable, the stored letter (already filtered when written, never regenerated) goes out once as a
 * ready task through chats.send. Setting `letter_followup:<thread>` records the decision, so each thread is decided
 * once. True = a letter task is waiting in this thread (the rest of the sync would close it).
 */
function letterFollowup(env: ChatEnv, thread: ChatThread, history: ChatMessage[], chatUrl: string, writable: boolean | undefined, since: string, budget: { left: number }): boolean {
  const key = letterKey(thread.id);
  const mark = env.store.getSetting(key);
  if (mark?.startsWith("task:")) return OPEN_TASK_STATES.includes(env.store.getChatTask(Number(mark.slice(5)))?.state ?? "closed");
  const letter = mark ? "" : storedLetter(env, thread, since);
  if (!letter) return false;
  // hh's «Без сопроводительного письма» line is not an employer turn.
  env.store.markAnswered(history.filter((m) => m.direction === "in" && !m.answered && NO_LETTER.test(m.text)).map((m) => m.id));
  const probe = norm(letter).slice(0, 60);
  const skip =
    history.some((m) => m.direction === "out" && norm(m.text).includes(probe)) ? "attached"
    : history.some((m) => m.direction === "in" && !NO_LETTER.test(m.text)) ? "employer replied"
    : writable === false ? "chat closed"
    : "";
  if (skip) {
    env.store.setSetting(key, skip);
    return false;
  }
  if (budget.left <= 0) return false;
  budget.left--;
  const at = env.now().toISOString();
  const task = env.store.insertChatTask({ userId: thread.userId, threadId: thread.id, messageIds: [], target: chatUrl, state: "ready" }, at);
  env.store.patchChatTask(task.id, "ready", { draft: letter }, at);
  env.store.setSetting(key, `task:${task.id}`);
  env.enqueue("chats.send", { taskId: task.id }, { key: `send:${task.id}`, priority: 1 });
  env.log.info("chats", `${thread.employer}: no cover letter in the chat, sending the stored one`, { thread_id: thread.id, task_id: task.id });
  return true;
}

export const FEEDBACK_REQUEST =
  "Здравствуйте. Спасибо за ответ. Подскажите, пожалуйста, что именно в опыте или навыках не подошло под эту роль? Подробная обратная связь поможет мне прицельнее готовиться, буду благодарен за любые детали.";

const linkTriedKey = (threadId: number) => `vacancy_link_tried:${threadId}`;

/** A chat's vacancy that isn't in the store (applied from another machine or by hand): fetch it once. */
async function linkChatVacancy(env: ChatEnv, s: BrowserSession, ext: string, employer: string, threadId: number | undefined): Promise<Vacancy | null> {
  if (threadId !== undefined) env.store.setSetting(linkTriedKey(threadId), env.now().toISOString());
  try {
    const url = vacancyUrl(ext);
    const r = await env.hh.fetchVacancy(s, { externalId: ext, url, title: "", company: employer, salaryRaw: "" });
    const base = ensureVacancy(env.store, skeletonVacancy("hh", ext, url, r.vacancy.title, r.vacancy.company || employer));
    return env.store.upsertVacancy({ ...r.vacancy, id: base.id });
  } catch (e) {
    env.log.warn("chats", `${employer}: vacancy ${ext} not linked: ${errMessage(e)}`);
    return null;
  }
}

/** One polite feedback request per rejection; settings `feedback_request` = "0" turns it off. */
async function askFeedback(env: ChatEnv, s: BrowserSession, chatUrl: string, employer: string, threadId: number, writable: boolean | undefined): Promise<void> {
  if (env.store.getSetting("feedback_request") === "0") return;
  if (writable === false) {
    env.log.info("chats", `${employer}: rejected, chat is closed for writing, no feedback request`, { thread_id: threadId });
    return;
  }
  await env.hh.sendMessage(s, chatUrl, FEEDBACK_REQUEST);
  env.store.insertChatMessages(threadId, [{ hhMessageId: null, direction: "out", author: "me", text: FEEDBACK_REQUEST, isQuestion: false, answered: true }]);
  env.log.info("chats", `${employer}: rejected, asked for feedback`, { thread_id: threadId });
  await env.throttle.afterMutation();
}

export async function syncHHChats(env: ChatEnv, user: User): Promise<void> {
  const s = await env.browser.openHH(user);
  const known = new Map(env.store.listChatThreads(user.id).map((t) => [t.hhNegotiationId, t]));
  // hh marks a chat read as soon as anyone opens it (the seeker on the phone), so "unread" alone loses
  // threads. Take the recent list and decide from our own state.
  // Every chat modified since `chat_track_since` (a date, Moscow midnight) is tracked, read or not.
  const sinceDay = env.store.getSetting("chat_track_since") || CHAT_TRACK_SINCE_DEFAULT;
  const since = new Date(`${sinceDay}T00:00:00+03:00`).toISOString();
  const all = await env.hh.listThreads(s, false, since);
  // Chats an employer started (hh's «ИИ-помощник» outreach) exist only in the chat list: read it once and add
  // every chat the negotiations list doesn't have (keyed by its topic id, so a chat in both lists is one thread).
  // Any new activity moves a chat to the top, so after one full read only pages newer than the last read (minus
  // an hour of slack) are needed; the full window again whenever the open cap left chats for later.
  const listKey = `chat_list_read:${user.id}`;
  const listSince = [since, env.store.getSetting(listKey) ?? ""].sort().at(-1)!;
  const listed = new Set(all.map((t) => t.negotiationId));
  let listOk = true;
  const extra = (
    await env.hh.listChats(s, listSince, CHAT_LIST_MAX_PAGES).catch((e: unknown) => {
      env.log.warn("chats", `hh ${user.slug}: chat list not read: ${errMessage(e)}`);
      listOk = false;
      return [];
    })
  ).filter((t) => !listed.has(t.negotiationId) && (listed.add(t.negotiationId), true));
  let backfill = LETTER_MAX_PER_SYNC;
  const letters = { left: LETTER_MAX_PER_SYNC };
  const needsLook = (t: ThreadRow): boolean => {
    const prev = known.get(t.negotiationId);
    const recent = !t.lastModified || t.lastModified >= since;
    // A chat we already track keeps being handled even if older than the cutoff (e.g. a reply waiting for
    // the human's skill answers); new chats only count from the cutoff on.
    if (!prev) return recent;
    if (t.unread) return true;
    if (mapNegotiationState(t.state) === "invited" && prev.state !== "invited") return true; // a new invitation
    // An invitation whose vacancy we never stored (applied from elsewhere): read it once to link it,
    // so the prep brief and the study checklist have a job description.
    if (prev.state === "invited" && prev.vacancyId === null && !env.store.getSetting(linkTriedKey(prev.id))) {
      env.store.setSetting(linkTriedKey(prev.id), env.now().toISOString()); // once, even if the chat names no vacancy
      return true;
    }
    if (t.lastModified && t.lastModified > prev.lastSeenAt) return true;
    if (env.store.listChatMessages(prev.id).some((m) => m.direction === "in" && !m.answered)) return true;
    // Letter backfill: a quiet chat of our application whose letter was never checked (a few per sync).
    return backfill > 0 && prev.state !== "rejected" && !env.store.getSetting(letterKey(prev.id)) && !!storedLetter(env, prev, since) && backfill-- > 0;
  };
  // The chat list is newest first; a burst of outreach waits for the next sync instead of stretching this one.
  const fromList = extra.filter(needsLook);
  const threads = all.filter(needsLook).concat(fromList.slice(0, CHAT_LIST_MAX_OPENS));
  if (listOk) env.store.setSetting(listKey, fromList.length > CHAT_LIST_MAX_OPENS ? "" : new Date(env.now().getTime() - 3600_000).toISOString());
  env.log.info("chats", `hh ${user.slug}: ${threads.length} of ${all.length + extra.length} threads need a look`, { threads: threads.length });
  for (const t of threads) {
    try {
      const detail = await env.hh.readThread(s, t.chatUrl);
      t.employer ||= detail.thread.employer; // the chat list no longer carries employer names; the chat page does
      // The negotiations list knows invitations (INVITATION / INTERVIEW) that the chat page doesn't show.
      if (detail.thread.state !== "rejected" && mapNegotiationState(t.state) === "invited") detail.thread.state = "invited";
      const prev = known.get(t.negotiationId);
      const ext = detail.vacancyExternalId ?? t.vacancyExternalId;
      let vacancy = ext ? env.store.findVacancyByExternal("hh", ext) : null;
      if (!vacancy && ext && !prev?.vacancyId) vacancy = await linkChatVacancy(env, s, ext, t.employer, prev?.id);
      const thread = env.store.upsertChatThread({
        ...detail.thread,
        id: prev?.id,
        userId: user.id,
        hhNegotiationId: t.negotiationId,
        vacancyId: vacancy?.id ?? prev?.vacancyId ?? null,
        // rejected is sticky (later messages are feedback) and ends a pending human question; an invitation
        // outranks a pending human question
        state:
          detail.thread.state === "invited" ? "invited"
          : detail.thread.state === "rejected" || prev?.state === "rejected" ? "rejected"
          : prev?.state === "needs_human" ? "needs_human"
          : detail.thread.state,
        lastSeenAt: env.now().toISOString(),
      });
      const inserted = env.store.insertChatMessages(thread.id, detail.messages);
      let history = env.store.listChatMessages(thread.id);
      if (!prev && t.negotiationId.startsWith("chat:")) {
        // No application of ours behind it: the agent answers it like any employer turn; if it ends in «откликнуться?»,
        // the «да» in the chat is the application (hh's assistant files it). The human gets the links to check.
        const said = detail.messages.find((m) => m.direction === "in" && m.text.trim())?.text.trim().slice(0, 500);
        const vlink = ext ? `\n${vacancyUrl(ext)}` : "";
        await env.notifier.alert(`✉️ Работодатель написал первым: ${t.employer}`, `${user.name}${vacancy?.title ? `, ${vacancy.title}` : ""}.${said ? `\n\n«${said}»\n` : ""}\nАгент ответит в чате; если нужен отклик через hh, откликнись по ссылке.${vlink}\n${t.chatUrl}`).catch(() => undefined);
      }
      if (detail.thread.state === "invited" && prev?.state !== "invited") {
        env.log.info("chats", `${t.employer}: INVITATION`, { thread_id: thread.id });
        const vtitle = vacancy?.title ? ` (${vacancy.title})` : "";
        const said = [...detail.messages].reverse().find((m) => m.direction === "in" && m.text.trim())?.text.trim().slice(0, 800);
        const title = `🎉 Приглашение: ${t.employer}${vtitle}`;
        const body = `${user.name}: работодатель пригласил на следующий этап.\n${said ? `\n«${said}»\n\n` : ""}${t.chatUrl}`;
        await (vacancy ? alertWithStudy(env.notifier, title, body, thread.id) : env.notifier.alert(title, body)).catch(() => undefined);
        if (vacancy) env.enqueue("chats.prep", { threadId: thread.id, invitation: said ?? "" }, { key: `prep:${thread.id}` });
      }
      if (detail.thread.state === "rejected" && prev?.state !== "rejected") {
        // The thread is stored rejected already: a failed feedback request must still mark the rejection
        // handled, or the next sync forwards the rejection itself as «Фидбек».
        await askFeedback(env, s, t.chatUrl, t.employer, thread.id, detail.writable).catch((e: unknown) => env.log.warn("chats", `${t.employer}: feedback request not sent: ${errMessage(e)}`, { thread_id: thread.id }));
        settleThread(env, thread.id, "отказ");
        continue;
      }
      if (prev?.state === "rejected") {
        // Anything the employer writes after a rejection is feedback: forward it, never auto-reply.
        const fresh = history.filter((m) => m.direction === "in" && !m.answered);
        if (fresh.length) await env.notifier.alert(`Фидбек от ${t.employer}`, `${user.name}: ${fresh.map((m) => m.text).join("\n\n")}\n${t.chatUrl}`).catch(() => undefined);
        settleThread(env, thread.id, "отказ, фидбек переслан");
        continue;
      }
      // hh can keep a submitted questionnaire in the chat state: the same questions are answered once.
      // ponytail: the survey's LLM call runs inside this browser job; a job of its own if surveys get frequent.
      const surveyKey = `survey_done:${thread.id}`;
      const surveySig = JSON.stringify(detail.survey.map((q) => q.text));
      if (detail.survey.length && env.store.getSetting(surveyKey) !== surveySig) {
        const answers = await env.llm.answerQuestionnaire(env.store.getProfile(user.id)!, vacancy, detail.survey, kbForVacancy(env.store, user.id, vacancy, renderQuestions(detail.survey)));
        await env.hh.submitSurvey(s, t.chatUrl, answers);
        env.store.setSetting(surveyKey, surveySig);
        // Only the survey's own questions are answered by it; typed employer text next to it goes on to a reply task.
        const asked = new Set(detail.survey.map((q) => q.text.replace(/\s+/g, " ").trim()));
        env.store.markAnswered(history.filter((m) => m.direction === "in" && !m.answered && asked.has(m.text.replace(/\s+/g, " ").trim())).map((m) => m.id));
        env.log.info("chats", `${t.employer}: survey answered (${detail.survey.length} questions)`, { thread_id: thread.id });
        await env.throttle.afterMutation();
        history = env.store.listChatMessages(thread.id);
      }
      if (letterFollowup(env, thread, history, t.chatUrl, detail.writable, since, letters)) continue;
      if (prev?.state === "needs_human" && inserted === 0) {
        env.log.info("chats", `${t.employer}: still waiting for a human`, { thread_id: thread.id });
        settleThread(env, thread.id, "ждёт человека"); // the human answers on hh; new messages reopen it
        continue;
      }
      if (detail.writable === false) {
        // hh closed this chat for the applicant (employer setting or no invitation): nothing can be sent.
        settleThread(env, thread.id, "чат закрыт для сообщений");
        continue;
      }
      // Only employer messages after our last one need a reply: earlier ones were answered (by hand or by us).
      const lastOut = history.findLastIndex((m) => m.direction === "out");
      env.store.markAnswered(history.slice(0, Math.max(lastOut, 0)).filter((m) => m.direction === "in" && !m.answered).map((m) => m.id));
      // Our message is the last one (answered by hand on the phone): nothing to reply.
      if (history.at(-1)?.direction === "out") {
        settleThread(env, thread.id, "ответ уже есть в чате");
        await env.throttle.afterRead();
        continue;
      }
      reconcileThread(env, thread, t.chatUrl, detail.choices ?? []);
      await env.throttle.afterRead();
    } catch (e) {
      env.log.error("chats", `${t.employer}: ${errMessage(e)}`, { negotiation: t.negotiationId });
    }
  }
  await followupChats(env, user, s, all.filter((t) => !threads.includes(t)), known);
}
