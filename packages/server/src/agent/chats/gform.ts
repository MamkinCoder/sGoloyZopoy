// Google Forms sent by employers in hh chats (docs.google.com/forms, forms.gle). chats.sync spots the link and
// queues `chats.gform`: the form is read over HTTP (src/gforms), answered like any employer questionnaire, and ONE
// Telegram card shows the whole filled form with «Отправить» / «Пропустить». A plain-text message to the bot revises
// the answers («зарплату побольше»), the card is updated in place. Nothing is submitted without the tap, unless the
// setting gform_mode is "auto". Pending forms live in settings as JSON `gform:<id>` (no table for a few per week).
import { errMessage, type Answer, type ChatThread, type TapReply, type TgButton, type User, type Vacancy } from "@sgz/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFormUrls, fetchForm, formKey, formQuestions, missingRequired, submitForm, answerValues, type GForm } from "../../gforms/index.js";
import { kbForVacancy } from "../../kb/context.js";
import { renderAnswers, renderQuestions } from "../../llm/format.js";
import { escapeHtml } from "../../notify/format.js";
import { skeletonVacancy } from "../../runner/filters.js";
import { userById, userNotifier, type ChatEnv } from "./env.js";

export type GFormState = "awaiting" | "sent" | "skipped";

interface GFormTask {
  id: number;
  userId: number;
  threadId: number;
  employer: string;
  url: string;
  form: GForm;
  answers: Answer[];
  state: GFormState;
  tgMessageId: number | null;
  /** «Изменить» was tapped: the next free text of the chat is the correction for this card. */
  editing?: boolean;
}

const taskKey = (id: number) => `gform:${id}`;
const OPEN_KEY = "gform_open";
const seenKey = (threadId: number, url: string) => `gform_seen:${threadId}:${formKey(url)}`;
const CARD_MAX = 3900;

const load = (env: ChatEnv, id: number): GFormTask | null => {
  const raw = env.store.getSetting(taskKey(id));
  return raw ? (JSON.parse(raw) as GFormTask) : null;
};
const save = (env: ChatEnv, t: GFormTask): void => env.store.setSetting(taskKey(t.id), JSON.stringify(t));
const openIds = (env: ChatEnv): number[] => JSON.parse(env.store.getSetting(OPEN_KEY) ?? "[]") as number[];
const setOpen = (env: ChatEnv, ids: number[]): void => env.store.setSetting(OPEN_KEY, JSON.stringify(ids.slice(-20)));

/** chats.sync: marks the link seen. True the first time only, so one link is one job however many syncs read it. */
export function claimForm(env: ChatEnv, threadId: number, url: string): boolean {
  if (env.store.getSetting(seenKey(threadId, url))) return false;
  env.store.setSetting(seenKey(threadId, url), env.now().toISOString());
  return true;
}

/** A message that is just the link (plus a few words) is answered by filling the form: no chat reply task for it. */
export function isLinkOnly(text: string, urls: string[]): boolean {
  const rest = urls.reduce((s, u) => s.split(u).join(" "), text).replace(/\s+/g, " ").trim();
  return rest.length <= 160 && !rest.includes("?");
}

/** Form links in stored employer messages of the last `BACKFILL_DAYS` days (not rejected chats) that no job took yet:
 *  covers links that arrived while chats.sync was down or before this feature. One job per link, `claimForm` dedups
 *  against chats.sync, so this is safe to run repeatedly (it is scheduled, the first time right at start). */
export const BACKFILL_DAYS = 10;
export const BACKFILL_MAX = 15;
export function backfillForms(env: ChatEnv): number {
  const from = env.now().getTime() - BACKFILL_DAYS * 86_400_000;
  let n = 0;
  for (const u of env.store.listUsers(true)) {
    for (const thread of env.store.listChatThreads(u.id)) {
      if (thread.state === "rejected") continue;
      for (const m of env.store.listChatMessages(thread.id)) {
        if (m.direction !== "in" || Date.parse(m.createdAt) < from) continue;
        for (const url of extractFormUrls(m.text)) {
          if (n >= BACKFILL_MAX || !claimForm(env, thread.id, url)) continue;
          env.enqueue("chats.gform", { threadId: thread.id, url }, { key: `gform:${thread.id}:${formKey(url)}` });
          env.log.info("chats", `${thread.employer}: google form found in an earlier message, backfilling`, { thread_id: thread.id });
          n++;
        }
      }
    }
  }
  return n;
}

// ------------------------------------------------------------ the card

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The card as one Telegram message, null when even short answers do not fit (then the answers go as a file). */
function fitted(t: GFormTask, footer: string): string | null {
  const head = `📝 <b>Google Форма: ${escapeHtml(t.employer)}</b>${t.form.title ? `\n${escapeHtml(t.form.title)}` : ""}`;
  for (const max of [400, 220, 120, 60]) {
    const body = t.form.questions
      .map((q, idx) => {
        const v = answerValues(q, t.answers.find((a) => a.idx === idx)).join("; ");
        return `<b>${escapeHtml(cut(q.title, 140))}</b>\n→ ${v ? escapeHtml(cut(v, max)) : "<i>пусто</i>"}`;
      })
      .join("\n\n");
    const text = `${head}\n\n${body}\n\n${footer}`;
    if (text.length <= CARD_MAX) return text;
  }
  return null;
}

function card(t: GFormTask, footer: string): string {
  const text = fitted(t, footer);
  if (text) return text;
  const head = `📝 <b>Google Форма: ${escapeHtml(t.employer)}</b>${t.form.title ? `\n${escapeHtml(t.form.title)}` : ""}`;
  return `${head}\n\n${t.form.questions.length} вопросов: не помещаются в сообщение, все ответы пришлю файлом answers.txt.\n${t.url}\n\n${footer}`;
}

const overflows = (t: GFormTask): boolean => fitted(t, ASK_FOOTER) === null;

/** Every question with its answer as a text file (cards too long for Telegram). */
async function sendAnswers(env: ChatEnv, t: GFormTask): Promise<void> {
  const notifier = userNotifier(env, t.userId);
  if (!notifier.document) return;
  const body = t.form.questions
    .map((q, idx) => `${idx + 1}. ${q.title}${q.required ? " *" : ""}\n   → ${answerValues(q, t.answers.find((a) => a.idx === idx)).join("; ") || "(пусто)"}`)
    .join("\n\n");
  const dir = mkdtempSync(join(tmpdir(), "sgz-gform-"));
  const path = join(dir, "answers.txt");
  writeFileSync(path, `${t.employer}\n${t.form.title}\n${t.url}\n\n${body}\n`);
  try {
    await notifier.document({ path, filename: "answers.txt", caption: `Ответы в форме «${t.form.title || t.employer}»` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ASK_FOOTER = "Отправить как есть? Если что-то не так, нажми «Изменить» и напиши, что поправить.";
const EDIT_FOOTER = "✏️ Жду правку: напиши следующим сообщением, что поменять (например «зарплату побольше»).";
const buttons = (t: GFormTask): TgButton[][] => (t.state === "awaiting" ? [[{ text: "✅ Отправить", data: `gf:${t.id}:s` }, { text: "✏️ Изменить", data: `gf:${t.id}:e` }, { text: "Пропустить", data: `gf:${t.id}:x` }]] : []);

// ------------------------------------------------------------ chats.gform (llm)

const alertManual = (env: ChatEnv, user: User, employer: string, url: string, why: string) =>
  userNotifier(env, user.id).alert(`Google Форма от ${employer}: заполни сам`, `${why}\n${url}`).catch(() => undefined);

export async function gformJob(env: ChatEnv, payload: { threadId: number; url: string }): Promise<void> {
  const thread = env.store.getChatThread(payload.threadId);
  const user = thread && userById(env.store, thread.userId);
  const profile = user && env.store.getProfile(user.id);
  if (!thread || !user || !profile) return;
  const employer = thread.employer || "работодатель";
  let form: GForm;
  try {
    form = await fetchForm(payload.url);
  } catch (e) {
    await alertManual(env, user, employer, payload.url, `Не смог прочитать форму: ${errMessage(e)}`);
    return;
  }
  // The same form reached through two links (forms.gle and docs.google.com): one card.
  const doneKey = `gform_form:${thread.id}:${form.id}`;
  if (env.store.getSetting(doneKey)) return;
  env.store.setSetting(doneKey, env.now().toISOString());
  if (form.unsupported.length) {
    await alertManual(env, user, employer, payload.url, `Автозаполнение не подходит: ${form.unsupported.join("; ")}`);
    return;
  }
  const qs = formQuestions(form);
  const linked = thread.vacancyId === null ? null : env.store.getVacancy(thread.vacancyId);
  // Without a linked vacancy the form's own text (usually the job post) is the context.
  const vacancy = linked ?? ({ id: 0, firstSeenAt: env.now().toISOString(), lastSeenAt: env.now().toISOString(), ...skeletonVacancy("hh", `gform:${form.id}`, payload.url, form.title || "Анкета", employer), descriptionText: form.description } as Vacancy);
  const answers = await env.llm.answerQuestionnaire(profile, vacancy, qs, kbForVacancy(env.store, user.id, vacancy, renderQuestions(qs)));
  const missing = missingRequired(form, answers);
  if (missing.length) {
    await alertManual(env, user, employer, payload.url, `Не на все обязательные вопросы нашёл ответ: ${missing.join("; ")}`);
    return;
  }
  const seq = Number(env.store.getSetting("gform_seq") ?? "0") + 1;
  env.store.setSetting("gform_seq", String(seq));
  const task: GFormTask = { id: seq, userId: user.id, threadId: thread.id, employer, url: payload.url, form, answers, state: "awaiting", tgMessageId: null };
  if (env.store.getSetting("gform_mode") === "auto") {
    await sendForm(env, task, profile.email);
    await userNotifier(env, user.id).alert(`Google Форма отправлена: ${employer}`, cut(renderAnswers(qs, answers), 1500)).catch(() => undefined);
    return;
  }
  save(env, task);
  setOpen(env, [...openIds(env), task.id]);
  const id = await userNotifier(env, user.id).ask?.(card(task, ASK_FOOTER), buttons(task));
  if (typeof id === "number") save(env, { ...task, tgMessageId: id });
  if (overflows(task)) await sendAnswers(env, task).catch((e: unknown) => env.log.warn("chats", `${employer}: answers file not sent: ${errMessage(e)}`));
  env.log.info("chats", `${employer}: google form «${form.title}» drafted (${qs.length} questions), waiting for the tap`, { thread_id: thread.id });
}

async function sendForm(env: ChatEnv, t: GFormTask, email: string): Promise<void> {
  await submitForm(t.form, t.answers, email);
  save(env, { ...t, state: "sent" });
  setOpen(env, openIds(env).filter((i) => i !== t.id));
  env.log.info("chats", `${t.employer}: google form submitted`, { thread_id: t.threadId });
}

// ------------------------------------------------------------ Telegram: taps and free text

export function parseGformCallback(data: string): { id: number; action: "s" | "x" | "e" } | null {
  const m = /^gf:(\d+):([sxe])$/.exec(data);
  return m ? { id: Number(m[1]), action: m[2] as "s" | "x" | "e" } : null;
}

export const gformOwner = (env: ChatEnv, id: number): number | undefined => load(env, id)?.userId;

export async function onGformTap(env: ChatEnv, tap: { id: number; action: "s" | "x" | "e" }): Promise<TapReply | string> {
  const t = load(env, tap.id);
  if (!t) return "форма устарела";
  if (t.state !== "awaiting") return { note: t.state === "sent" ? "уже отправлено" : "уже пропущено", text: card(t, t.state === "sent" ? "✅ Отправлено." : "Пропущено."), buttons: [] };
  if (tap.action === "e") {
    // One card at a time takes the next text.
    for (const i of openIds(env)) {
      const o = i === t.id ? null : load(env, i);
      if (o?.editing) save(env, { ...o, editing: false });
    }
    const next = { ...t, editing: true };
    save(env, next);
    if (overflows(next)) await sendAnswers(env, next).catch(() => undefined);
    return { note: "Напиши, что поправить", text: card(next, EDIT_FOOTER), buttons: buttons(next), say: "Что поправить в форме? Напиши обычным сообщением, например «зарплату побольше»." };
  }
  if (tap.action === "x") {
    save(env, { ...t, state: "skipped" });
    setOpen(env, openIds(env).filter((i) => i !== t.id));
    return { note: "Пропустил", text: card({ ...t, state: "skipped" }, `Пропущено. Форма: ${t.url}`), buttons: [] };
  }
  try {
    await sendForm(env, t, env.store.getProfile(t.userId)?.email ?? "");
  } catch (e) {
    return { note: "Не отправилось", text: card(t, `⚠️ Не отправилось: ${escapeHtml(errMessage(e))}\nМожно нажать ещё раз или заполнить самому: ${t.url}`), buttons: buttons(t) };
  }
  return { note: "Отправлено", text: card({ ...t, state: "sent" }, "✅ Форма отправлена."), buttons: [] };
}

/** Free text from the seeker's chat revises the latest open form card of that chat. null = no open form here. */
export async function gformText(env: ChatEnv, chatId: string, text: string): Promise<string | null> {
  const mine = (t: GFormTask | null): t is GFormTask => !!t && t.state === "awaiting" && (userById(env.store, t.userId)?.tgChatId || env.cfg.tgChatId) === chatId;
  const cards = [...openIds(env)].reverse().map((i) => load(env, i)).filter(mine);
  const t = cards.find((c) => c.editing) ?? cards[0];
  if (!t) return null;
  const profile = env.store.getProfile(t.userId);
  if (!profile) return null;
  const qs = formQuestions(t.form);
  const thread: ChatThread | null = env.store.getChatThread(t.threadId);
  const vacancy = thread?.vacancyId == null ? null : env.store.getVacancy(thread.vacancyId);
  const answers = await env.llm.reviseAnswers(profile, vacancy, qs, t.answers, text, kbForVacancy(env.store, t.userId, vacancy, renderQuestions(qs)));
  const missing = missingRequired(t.form, answers);
  if (missing.length) return `Не получилось: после правки остались пустыми обязательные вопросы (${missing.join("; ")}). Напиши иначе.`;
  const next = { ...t, answers, editing: false };
  save(env, next);
  const notifier = userNotifier(env, t.userId);
  if (t.tgMessageId !== null && notifier.edit) await notifier.edit(t.tgMessageId, card(next, ASK_FOOTER), buttons(next)).catch(() => undefined);
  else await notifier.ask?.(card(next, ASK_FOOTER), buttons(next));
  if (overflows(next)) await sendAnswers(env, next).catch(() => undefined);
  return "Поправил, смотри обновлённую карточку выше.";
}
