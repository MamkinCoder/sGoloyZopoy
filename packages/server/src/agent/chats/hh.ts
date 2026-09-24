// chats.sync, hh.ru part: read the chat list, store new messages, keep today's side effects (invitation
// alert + prep, rejection feedback request, feedback forwarding, bot surveys, follow-ups) and open a reply task
// for every thread with unanswered employer messages. Replies themselves are written by the task jobs.
import type { BrowserSession, User, Vacancy } from "@sgz/shared";
import { mapNegotiationState } from "../../hh/state.js";
import { vacancyUrl } from "../../hh/urls.js";
import { followupChats } from "../../runner/interview.js";
import { ensureVacancy, skeletonVacancy } from "../../runner/filters.js";
import { alertWithStudy } from "../../runner/study.js";
import { errMessage } from "../../runner/util.js";
import type { ChatEnv } from "./env.js";
import { closeTask, reconcileThread, unansweredIds } from "./tasks.js";

export const CHAT_TRACK_SINCE_DEFAULT = "2026-09-23";

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
  const threads = all.filter((t) => {
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
    return env.store.listChatMessages(prev.id).some((m) => m.direction === "in" && !m.answered);
  });
  env.log.info("chats", `hh ${user.slug}: ${threads.length} of ${all.length} threads need a look`, { threads: threads.length });
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
      const history = env.store.listChatMessages(thread.id);
      const handled = (why: string) => {
        const open = env.store.openChatTask(thread.id);
        if (open && open.state !== "sending") closeTask(env, open, why);
        env.store.markAnswered(unansweredIds(env.store.listChatMessages(thread.id)));
      };
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
        await askFeedback(env, s, t.chatUrl, t.employer, thread.id, detail.writable);
        handled("отказ");
        continue;
      }
      if (prev?.state === "rejected") {
        // Anything the employer writes after a rejection is feedback: forward it, never auto-reply.
        const fresh = history.filter((m) => m.direction === "in" && !m.answered);
        if (fresh.length) await env.notifier.alert(`Фидбек от ${t.employer}`, `${user.name}: ${fresh.map((m) => m.text).join("\n\n")}\n${t.chatUrl}`).catch(() => undefined);
        handled("отказ, фидбек переслан");
        continue;
      }
      // hh can keep a submitted questionnaire in the chat state: the same questions are answered once.
      // ponytail: the survey's LLM call runs inside this browser job; a job of its own if surveys get frequent.
      const surveyKey = `survey_done:${thread.id}`;
      const surveySig = JSON.stringify(detail.survey.map((q) => q.text));
      if (detail.survey.length && env.store.getSetting(surveyKey) !== surveySig) {
        const answers = await env.llm.answerQuestionnaire(env.store.getProfile(user.id)!, vacancy, detail.survey);
        await env.hh.submitSurvey(s, t.chatUrl, answers);
        env.store.setSetting(surveyKey, surveySig);
        handled("опрос заполнен");
        env.log.info("chats", `${t.employer}: survey answered (${detail.survey.length} questions)`, { thread_id: thread.id });
        await env.throttle.afterMutation();
        continue;
      }
      if (prev?.state === "needs_human" && inserted === 0) {
        env.log.info("chats", `${t.employer}: still waiting for a human`, { thread_id: thread.id });
        handled("ждёт человека"); // the human answers on hh; new messages reopen it
        continue;
      }
      if (detail.writable === false) {
        // hh closed this chat for the applicant (employer setting or no invitation): nothing can be sent.
        handled("чат закрыт для сообщений");
        continue;
      }
      // Our message is the last one (answered by hand on the phone): nothing to reply.
      if (history.at(-1)?.direction === "out") {
        handled("ответ уже есть в чате");
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
