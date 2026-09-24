// Chat replies as a state machine (docs/ARCHITECTURE.md §3). One reply task per employer turn:
//   new -> triage -> awaiting_review -> drafting -> ready -> sending -> sent
//   closed: handled without a reply (ack-only, rejection, empty draft, answered by hand, chat closed)
//   superseded: the employer wrote again before we sent; a fresh task covers all unanswered messages
//   failed: a job exhausted its retries, or a send could not be confirmed (alerted per task by failTask)
// Every step is a job keyed by the task id, reads the task from the DB and moves it with compare-and-set,
// so repeats, restarts and a sync racing a draft are harmless.
import { OPEN_TASK_STATES, tagIs, type ChatMessage, type ChatTask, type ChatThread, type ChatTopic, type Profile, type TapReply, type Vacancy } from "@sgz/shared";
import { conversationUrl } from "../../habr/state.js";
import { kbFor, renderKb } from "../../kb/context.js";
import { asksQuestion } from "../../hh/state.js";
import { learnedSkills, legacySkillName, skillKey, withLearnedSkills } from "../../runner/skills.js";
import { errMessage } from "../../runner/util.js";
import { shortStamp } from "../../scheduler/tz.js";
import { userById, type ChatEnv } from "./env.js";
import { topicTag } from "./review.js";

export const SEND_RESYNC_MS = 30_000;
export const REMIND_AFTER_MS = 2 * 3600_000;
export const FALLBACK_AFTER_MS = 12 * 3600_000;
const KB_BUDGET = 3000;
export const READY_FOOTER = "Все ответы есть, готовлю ответ работодателю.";

export const isHabrThread = (t: Pick<ChatThread, "hhNegotiationId">): boolean => t.hhNegotiationId.startsWith("habr:");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
export const unansweredIds = (msgs: ChatMessage[]): number[] => msgs.filter((m) => m.direction === "in" && !m.answered).map((m) => m.id);
const iso = (env: ChatEnv) => env.now().toISOString();
/** Topic `t` is `name` or its KB alias (Go / Golang): one answer covers both. */
const sameSkill = (env: ChatEnv, userId: number, t: string, name: string) => same(t, name) || tagIs(topicTag(env.store, userId, t), name);
/** Set on the task right before the send click: a retry never clicks again, it only confirms. */
export const SEND_CLICKED = "отправка нажата, проверяю";
const later = (env: ChatEnv, ms: number) => new Date(env.now().getTime() + ms);

function threadOf(env: ChatEnv, task: Pick<ChatTask, "userId" | "threadId">): ChatThread | null {
  return env.store.listChatThreads(task.userId).find((t) => t.id === task.threadId) ?? null;
}

const link = (thread: ChatThread, task: ChatTask) => (isHabrThread(thread) ? conversationUrl(task.target) : task.target);

// ------------------------------------------------------------ opening tasks (called by chats.sync)

/**
 * After a thread's messages were stored: make sure exactly the right task is open. Unanswered employer messages
 * not covered by the open task supersede it (unless it is being sent right now) and open a fresh task over all
 * of them, carrying the topics the human already answered (`superseded`: the task chats.send just gave up). No unanswered messages: an open task is closed.
 */
export function reconcileThread(env: ChatEnv, thread: ChatThread, target: string, choices: string[] = [], superseded?: ChatTask): ChatTask | null {
  const ids = unansweredIds(env.store.listChatMessages(thread.id));
  const open = env.store.openChatTask(thread.id);
  if (!ids.length) {
    if (open && open.state !== "sending") closeTask(env, open, "ответ уже есть в чате");
    return null;
  }
  if (!open) {
    // A task that failed over these same messages is not retried every sync (failTask alerted);
    // a new employer message opens a fresh one.
    const last = env.store.latestChatTasks(thread.userId).get(thread.id);
    if (last?.state === "failed" && ids.every((id) => last.messageIds.includes(id))) return null;
  }
  if (open) {
    if (open.state === "sending" || ids.every((id) => open.messageIds.includes(id))) return open;
    const from = OPEN_TASK_STATES.filter((s) => s !== "sending");
    if (!env.store.moveChatTask(open.id, from, "superseded", { lastError: "работодатель написал ещё, ответ пересобран" }, iso(env))) return env.store.openChatTask(thread.id);
    env.log.info("chats", `${thread.employer}: task #${open.id} superseded by new messages`, { thread_id: thread.id });
  }
  const carried = (open ?? superseded)?.topics.filter((t) => t.answer !== null && t.by !== "fallback") ?? [];
  const task = env.store.insertChatTask({ userId: thread.userId, threadId: thread.id, messageIds: ids, target, choices, topics: carried }, iso(env));
  env.enqueue("chats.triage", { taskId: task.id }, { key: `triage:${task.id}` });
  return task;
}

/** Ends an open task without a reply and marks its messages handled; its KB reviews stop waiting. */
export function closeTask(env: ChatEnv, task: ChatTask, why: string): void {
  if (!env.store.moveChatTask(task.id, OPEN_TASK_STATES as ChatTask["state"][], "closed", { lastError: why }, iso(env))) return;
  env.store.markAnswered(task.messageIds);
  env.review.expire(task.id);
}

/** A job of this task gave up: the task shows as failed in the panel, and every such task is alerted with its
 *  employer (the employer is left without a reply until the human answers by hand). */
export async function failTask(env: ChatEnv, taskId: number, error: string): Promise<void> {
  if (!env.store.moveChatTask(taskId, OPEN_TASK_STATES as ChatTask["state"][], "failed", { lastError: error }, iso(env))) return;
  env.review.expire(taskId);
  const task = env.store.getChatTask(taskId);
  const thread = task && threadOf(env, task);
  await env.notifier.alert(`Не ответил работодателю: ${thread?.employer ?? ""}`, `Ответь сам. Ошибка: ${error}${thread && task ? `\n${link(thread, task)}` : ""}`).catch(() => undefined);
}

// ------------------------------------------------------------ chats.triage (llm)

export async function triageTask(env: ChatEnv, taskId: number): Promise<void> {
  const task = env.store.getChatTask(taskId);
  if (!task || !env.store.moveChatTask(task.id, ["new", "triage"], "triage", {}, iso(env))) return;
  const history = env.store.listChatMessages(task.threadId);
  const fresh = history.filter((m) => task.messageIds.includes(m.id));
  const r = await env.llm.triageChat(knownProfile(env, task.userId), history, fresh);
  if (r.kind === "ack_only" || r.kind === "rejection") {
    // Today's behaviour: no reply (a rejection's feedback request is sent by chats.sync from the hh state).
    if (env.store.moveChatTask(task.id, "triage", "closed", { kind: r.kind, lastError: r.kind === "ack_only" ? "ответ не нужен" : "отказ" }, iso(env))) env.store.markAnswered(task.messageIds);
    return;
  }
  const topics: ChatTopic[] = r.topics.map((name) => task.topics.find((t) => same(t.name, name)) ?? { name, answer: null, by: null });
  for (const t of task.topics) if (!topics.some((x) => same(x.name, t.name))) topics.push(t);
  if (env.store.moveChatTask(task.id, "triage", "awaiting_review", { kind: r.kind, topics }, iso(env))) env.enqueue("chats.review", { taskId: task.id }, { key: `review:${task.id}` });
}

// ------------------------------------------------------------ chats.review (none): the gate

export async function reviewTask(env: ChatEnv, taskId: number): Promise<void> {
  const task = env.store.getChatTask(taskId);
  if (!task || task.state !== "awaiting_review") return;
  const topics = env.review.prefill(task);
  if (topics.every((t) => t.answer !== null)) return toDrafting(env, { ...task, topics });
  if (!env.store.patchChatTask(task.id, "awaiting_review", { topics }, iso(env))) return;
  // The timers first and the card best-effort: a Telegram outage must not fail the task, the 2 h reminder asks
  // again and the 12 h fallback still answers. Each review round (new topics from the draft) restarts both.
  env.enqueue("chats.remind", { taskId: task.id }, { key: `remind:${task.id}`, runAfter: later(env, REMIND_AFTER_MS), replace: true });
  env.enqueue("chats.fallback", { taskId: task.id }, { key: `fallback:${task.id}`, runAfter: later(env, FALLBACK_AFTER_MS), replace: true });
  const tgMessageId = await env.review.ask({ ...task, topics }, false).catch((e: unknown) => (env.log.warn("chats", `task #${task.id}: card not sent: ${errMessage(e)}`), null));
  if (tgMessageId !== null) env.store.patchChatTask(task.id, "awaiting_review", { tgMessageId }, iso(env));
  env.log.info("chats", `task #${task.id}: waiting for ${topics.filter((t) => !t.answer).map((t) => t.name).join(", ")}`, { thread_id: task.threadId });
}

function toDrafting(env: ChatEnv, task: ChatTask): void {
  if (env.store.moveChatTask(task.id, "awaiting_review", "drafting", { topics: task.topics }, iso(env))) env.enqueue("chats.draft", { taskId: task.id }, { key: `draft:${task.id}` });
}

/** chats.remind (2 h): the card again, once. */
export async function remindTask(env: ChatEnv, taskId: number): Promise<void> {
  const task = env.store.getChatTask(taskId);
  if (!task || task.state !== "awaiting_review" || task.reminded) return;
  if (!env.store.patchChatTask(task.id, "awaiting_review", { reminded: true }, iso(env))) return;
  const tgMessageId = await env.review.ask(task, true).catch(() => null);
  if (tgMessageId !== null) env.store.patchChatTask(task.id, "awaiting_review", { tgMessageId }, iso(env));
}

/** chats.fallback (12 h): stop waiting. An unanswered topic the KB already knows as a skill (verified_skills,
 *  a confirmed tag) is answered from it; the rest count as «нет» for this reply only: the draft says honestly it
 *  is not in production experience and never claims them. Not recorded as the human's answer; the open KB reviews expire. */
export async function fallbackTask(env: ChatEnv, taskId: number): Promise<void> {
  const task = env.store.getChatTask(taskId);
  if (!task || task.state !== "awaiting_review") return;
  const known = (name: string) => topicTag(env.store, task.userId, name).status === "yes";
  const pending = task.topics.filter((t) => t.answer === null && !known(t.name)).map((t) => t.name);
  const topics = task.topics.map((t): ChatTopic => (t.answer !== null ? t : known(t.name) ? { ...t, answer: "yes", by: "profile" } : { ...t, answer: "no", by: "fallback" }));
  if (!env.store.moveChatTask(task.id, "awaiting_review", "drafting", { topics }, iso(env))) return;
  env.review.expire(task.id);
  env.enqueue("chats.draft", { taskId: task.id }, { key: `draft:${task.id}` });
  const thread = threadOf(env, task);
  const unclaimed = pending.length ? ` Без заявлений о навыках: ${pending.join(", ")}.` : "";
  await env.notifier.alert(`Отвечаю без тебя: ${thread?.employer ?? ""}`, `12 часов без ответа по навыкам. Отвечу по базе знаний.${unclaimed}`).catch(() => undefined);
}

// ------------------------------------------------------------ Telegram taps

/** A tap on a phase-1 grouped card (`ct:`, ✅ = confirm, ❌ = no skill; KB cards use review.ts onKbTap): the answer goes into the task, the same card is edited. Only when every topic
 *  has an answer (any mix of ✅/❌) the task moves on to drafting. */
export function onCardTap(env: ChatEnv, tap: { taskId: number; idx: number; has: boolean }): TapReply | string {
  const task = env.store.getChatTask(tap.taskId);
  const topic = task?.topics[tap.idx];
  if (!task || !topic) return "эта карточка уже неактуальна";
  let target = task;
  if (task.state !== "awaiting_review") {
    // The employer wrote again: the card belongs to a superseded task, the answer goes to the open one.
    const open = env.store.openChatTask(task.threadId);
    if (open?.state === "awaiting_review" && open.topics.some((t) => same(t.name, topic.name) && t.answer === null)) target = open;
    else return { note: "уже учтено", ...env.review.card(task, stateFooter(task)) };
  }
  const done = answerTopic(env, target, topic.name, tap.has);
  if (!done) return { note: "уже учтено", ...env.review.card(task, stateFooter(task)) };
  return { note: `${tap.has ? "✅" : "❌"} ${topic.name}`, ...env.review.card(done, done.state === "awaiting_review" ? undefined : READY_FOOTER) };
}

/** Old one-skill cards (`sk:y|n:<user>:<key>`): the answer goes to every open task of that user waiting for
 *  the same skill; with none, it is only remembered. */
export function onLegacySkillTap(env: ChatEnv, cb: { has: boolean; userId: number; key: string }): string {
  let name = legacySkillName(env.store, cb.userId, cb.key, true);
  let hit = 0;
  for (const t of env.store.listChatTasks("awaiting_review")) {
    if (t.userId !== cb.userId) continue;
    const tp = t.topics.find((x) => x.answer === null && (skillKey(x.name) === cb.key || (name !== null && same(x.name, name))));
    if (!tp) continue;
    name ??= tp.name;
    if (answerTopic(env, t, tp.name, cb.has)) hit++;
  }
  if (!name) return "уже учтено";
  if (!hit) env.review.record(cb.userId, name, cb.has);
  return `${cb.has ? "✅" : "❌"} ${name} ${cb.has ? "есть" : "нет"}${hit ? ", отвечаю работодателю" : ", запомнил"}`;
}

/** Writes the answer (and remembers it via the gate); returns the updated task, null when nothing changed.
 *  Topics that are aliases of the same KB tag (Go / Golang) get the same answer. */
export function answerTopic(env: ChatEnv, task: ChatTask, name: string, has: boolean): ChatTask | null {
  const hit = (t: ChatTopic) => t.answer === null && sameSkill(env, task.userId, t.name, name);
  if (!task.topics.some(hit)) return null;
  const topics = task.topics.map((t): ChatTopic => (hit(t) ? { ...t, answer: has ? "yes" : "no", by: "human" } : t));
  if (!env.store.patchChatTask(task.id, "awaiting_review", { topics }, iso(env))) return null;
  env.review.record(task.userId, name, has, task.id);
  const next = { ...task, topics };
  if (topics.every((t) => t.answer !== null)) {
    toDrafting(env, next);
    return { ...next, state: "drafting" };
  }
  return next;
}

export function stateFooter(task: ChatTask): string {
  if (task.state === "sent") return "Ответ отправлен.";
  if (task.state === "superseded") return "Работодатель написал ещё, ответ пересобирается.";
  if (task.state === "closed" || task.state === "failed") return "Больше не ждёт ответа.";
  return READY_FOOTER;
}

// ------------------------------------------------------------ chats.draft (llm)

/** Profile + learned skills: what the gate treats as known. */
function knownProfile(env: ChatEnv, userId: number): Profile {
  const p = env.store.getProfile(userId);
  if (!p) throw new Error(`no profile for user ${userId}`);
  return withLearnedSkills(p, learnedSkills(env.store, userId));
}

/** The profile the draft sees: known skills plus this task's answers (✅ -> verified, ❌ -> never claim). */
export function draftProfile(p: Profile, topics: ChatTopic[]): Profile {
  const yes = topics.filter((t) => t.answer === "yes").map((t) => t.name);
  const no = topics.filter((t) => t.answer === "no").map((t) => t.name);
  return withLearnedSkills(p, { yes, no });
}

/** KB block for the draft: the task topics + tags named in the vacancy / question, statuses as this task
 *  answered them (a fallback «нет» is not claimed even while the tag is unknown), the best stories. */
export function draftKb(env: ChatEnv, task: ChatTask, vacancy: Vacancy | null, history: ChatMessage[]): string {
  const asked = history.filter((m) => task.messageIds.includes(m.id)).map((m) => m.text);
  const text = [vacancy ? `${vacancy.title}\n${vacancy.descriptionText}` : "", ...asked].join("\n");
  const kb = kbFor(env.store, task.userId, { tags: task.topics.map((t) => t.name), text }, KB_BUDGET);
  const topics = kb.topics.map((t) => {
    const answer = task.topics.find((x) => same(x.name, t.name))?.answer;
    return answer ? { ...t, status: answer } : t;
  });
  return renderKb({ ...kb, topics });
}

export async function draftTask(env: ChatEnv, taskId: number): Promise<void> {
  const task = env.store.getChatTask(taskId);
  if (!task || task.state !== "drafting") return;
  const thread = threadOf(env, task);
  if (!thread) throw new Error(`thread ${task.threadId} not found`);
  const history = env.store.listChatMessages(thread.id);
  const vacancy = thread.vacancyId === null ? null : env.store.getVacancy(thread.vacancyId);
  const reply = await env.llm.answerChat(draftProfile(knownProfile(env, task.userId), task.topics), vacancy, history, task.choices, draftKb(env, task, vacancy, history));
  const unknown = (reply.unknown_skills ?? []).filter((s) => !task.topics.some((t) => sameSkill(env, task.userId, t.name, s)));
  if (unknown.length) {
    // A skill triage missed: back to the gate with it (a new round: the reminder may come again).
    const topics = [...task.topics, ...unknown.map((name): ChatTopic => ({ name, answer: null, by: null }))];
    if (env.store.moveChatTask(task.id, "drafting", "awaiting_review", { topics, reminded: false }, iso(env))) env.enqueue("chats.review", { taskId: task.id }, { key: `review:${task.id}` });
    return;
  }
  // The same prompt would only ask again: no retries, the human answers.
  if (reply.unknown_skills?.length) return failTask(env, task.id, `ответ всё ещё спрашивает об отвеченных навыках: ${reply.unknown_skills.join(", ")}`);
  const text = reply.reply.trim();
  const moved = text
    ? env.store.moveChatTask(task.id, "drafting", "ready", { draft: text }, iso(env))
    : env.store.moveChatTask(task.id, "drafting", "closed", { lastError: reply.reason || "ответ не нужен" }, iso(env));
  if (!moved) return; // superseded while the model was writing
  if (text) env.enqueue("chats.send", { taskId: task.id }, { key: `send:${task.id}`, priority: 1 });
  else env.store.markAnswered(task.messageIds);

  const user = userById(env.store, task.userId);
  const last = history.filter((m) => task.messageIds.includes(m.id)).at(-1)?.text ?? "";
  const interviewAt = reply.interview_at && Date.parse(reply.interview_at) > env.now().getTime() ? reply.interview_at : null;
  if (interviewAt) env.store.setChatInterview(thread.id, interviewAt);
  const when = interviewAt ? `📅 Собеседование: ${shortStamp(new Date(interviewAt), env.cfg.tz)}\n\n` : "";
  if (reply.needs_human) {
    // A reply can still go out (e.g. «да, пришлите тестовое»); the human is pinged either way. An invitation
    // stays invited: downgrading it would re-announce the invitation on the next sync.
    // Re-read: a chats.sync may have changed the thread (invitation, linked vacancy) during the LLM call.
    const cur = threadOf(env, task);
    if (cur && cur.state !== "invited" && cur.state !== "rejected") env.store.upsertChatThread({ ...cur, state: "needs_human" });
    await env.notifier.alert(`Чат требует внимания: ${thread.employer}`, `${user?.name ?? ""}: ${last}\n\n${when}${text ? `Ответ бота: ${text}\n\n` : ""}${reply.reason}\n${link(thread, task)}`).catch(() => undefined);
  } else if (interviewAt && interviewAt !== thread.interviewAt) {
    await env.notifier.alert(`📅 Собеседование: ${thread.employer}`, `${user?.name ?? ""}: ${when}${link(thread, task)}`).catch(() => undefined);
  }
}

// ------------------------------------------------------------ chats.send (browser)

type PageMessage = Pick<ChatMessage, "hhMessageId" | "direction" | "author" | "text" | "isQuestion" | "answered"> & { createdAt?: string };

/** Our reply is on the page after the task's last employer message. `loose`: its start is enough (the clients'
 *  own send probe: the page may render the rest differently). */
export function repliedOnPage(page: PageMessage[], stored: ChatMessage[], task: ChatTask, draft: string, loose = false): boolean {
  const lastIn = stored.filter((m) => task.messageIds.includes(m.id)).at(-1);
  let from = -1;
  if (lastIn) for (let i = page.length - 1; i >= 0 && from < 0; i--) if (page[i]!.direction === "in" && (lastIn.hhMessageId ? page[i]!.hhMessageId === lastIn.hhMessageId : norm(page[i]!.text) === norm(lastIn.text))) from = i;
  const probe = norm(draft).slice(0, 60);
  return page.slice(from + 1).some((m) => m.direction === "out" && (norm(m.text) === norm(draft) || (loose && norm(m.text).includes(probe))));
}

export async function sendTask(env: ChatEnv, taskId: number): Promise<void> {
  const task = env.store.getChatTask(taskId);
  if (!task || !env.store.moveChatTask(task.id, ["ready", "sending"], "sending", {}, iso(env))) return;
  const thread = threadOf(env, task);
  const user = userById(env.store, task.userId);
  if (!thread || !user) throw new Error(`thread ${task.threadId} not found`);
  const habr = isHabrThread(thread);
  const s = habr ? await env.browser.openHabr(user) : await env.browser.openHH(user);
  const read = async (): Promise<{ messages: PageMessage[]; writable: boolean | undefined; choices: string[] }> => {
    if (!habr) {
      const d = await env.hh.readThread(s, task.target);
      return { messages: d.messages, writable: d.writable, choices: d.choices ?? [] };
    }
    if (!env.habr) throw new Error("habr client is not configured");
    const d = await env.habr.readConversation(s, task.target);
    const messages = d.messages.map((m): PageMessage => ({ hhMessageId: m.id, direction: m.mine ? "out" : "in", author: m.mine ? "me" : "employer", text: m.text, isQuestion: !m.mine && asksQuestion(m.text), answered: false }));
    return { messages, writable: d.writable, choices: [] };
  };

  // Idempotent: a retry (the confirm failed, the process died mid-send) first looks whether the reply is there.
  let page = await read();
  const clicked = task.lastError === SEND_CLICKED;
  if (!repliedOnPage(page.messages, env.store.listChatMessages(thread.id), task, task.draft, clicked)) {
    if (clicked) {
      // Clicked before and our copy of the page cannot confirm it: never send twice, the human checks.
      await failTask(env, task.id, "не уверен, что ответ ушёл: проверь чат, повторно не отправляю");
      return;
    }
    if (page.writable === false) {
      closeTask(env, task, "чат закрыт для сообщений");
      return;
    }
    env.store.insertChatMessages(thread.id, page.messages);
    const extra = unansweredIds(env.store.listChatMessages(thread.id)).filter((id) => !task.messageIds.includes(id));
    if (extra.length) {
      // Supersede: the employer wrote again after the draft; answer everything in one fresh reply.
      if (env.store.moveChatTask(task.id, "sending", "superseded", { lastError: "работодатель написал ещё до отправки" }, iso(env))) reconcileThread(env, thread, task.target, page.choices, task);
      return;
    }
    env.store.patchChatTask(task.id, "sending", { lastError: SEND_CLICKED }, iso(env));
    if (habr) await env.habr!.sendMessage(s, task.target, task.draft);
    else await env.hh.sendMessage(s, task.target, task.draft);
    // sendMessage already saw the text appear; our parse of the page may render it differently (typography,
    // Habr's markup): a mismatch is logged, never a reason to send again.
    page = await read();
    if (!repliedOnPage(page.messages, env.store.listChatMessages(thread.id), task, task.draft)) env.log.warn("chats", `task #${task.id}: sent, but the reply is not recognised on the page`, { thread_id: thread.id });
  }
  // The local copy first (no hh id = a bot reply in analytics), then the page (its copy of ours is skipped).
  env.store.insertChatMessages(thread.id, [{ hhMessageId: null, direction: "out", author: "me", text: task.draft, isQuestion: false, answered: true }]);
  env.store.insertChatMessages(thread.id, page.messages);
  env.store.markAnswered(task.messageIds);
  env.store.moveChatTask(task.id, "sending", "sent", { lastError: "" }, iso(env));
  env.log.info("chats", `${thread.employer}: replied: ${task.draft.slice(0, 120)}`, { thread_id: thread.id, task_id: task.id });
  // hh AI assistants answer within seconds: look again soon.
  env.enqueue("chats.sync", {}, { key: "chats.sync", runAfter: later(env, SEND_RESYNC_MS) });
  await env.throttle.afterMutation();
}
