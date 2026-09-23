// Chat extras around interviews: prep brief on an invitation, interview reminders, one polite follow-up
// after employer silence. All hh-internal; the follow-up is a fixed text (no LLM, no links).
import { INTERVIEW_OUTCOMES, RunAbortError, type BrowserSession, type ChatMessage, type ChatThread, type HHClient, type InterviewOutcome, type InterviewPrep, type Notifier, type Store, type Vacancy } from "@sgz/shared";
import { formatBand } from "../db/salary.js";
import { mapNegotiationState } from "../hh/state.js";
import { HH_ORIGIN } from "../hh/urls.js";
import { shortStamp } from "../scheduler/tz.js";
import type { RunContext } from "./context.js";
import type { UserRun } from "./user.js";
import { alertWithStudy } from "./study.js";
import { errMessage, isStop } from "./util.js";

type ThreadSummary = Awaited<ReturnType<HHClient["listThreads"]>>[number];

export const FOLLOW_UP =
  "Здравствуйте! Хотел уточнить, актуальна ли ещё вакансия? С удовольствием расскажу подробнее о своём опыте и готов созвониться в удобное время.";
/** Keeps follow-ups low-volume: at most this many per chat poll. */
const FOLLOWUP_PER_POLL = 3;
export const FOLLOWUP_DAYS_DEFAULT = "7";
/** Reminder lead time before an interview. */
const REMIND_BEFORE_MS = 2 * 3600_000;

/** A still-pending thread (new/viewed on both sides) silent for `days`, never followed up, nothing waiting on us. */
export function followupDue(prev: ChatThread | undefined, t: Pick<ThreadSummary, "state" | "lastModified">, history: ChatMessage[], now: Date, days: number): boolean {
  if (!prev || days <= 0 || !t.lastModified) return false;
  if (prev.state !== "new" && prev.state !== "viewed") return false;
  const hhState = mapNegotiationState(t.state);
  if (hhState !== "new" && hhState !== "viewed") return false;
  if (now.getTime() - Date.parse(t.lastModified) < days * 86_400_000) return false;
  if (history.some((m) => m.direction === "out" && m.text.trim() === FOLLOW_UP)) return false;
  const last = history.at(-1);
  return !(last?.direction === "in" && !last.answered); // an unhandled employer message is the main loop's job
}

/** Follow-up pass over the chats the main loop did not touch; returns the number sent. */
export async function followupChats(ctx: RunContext, u: UserRun, s: BrowserSession, rest: ThreadSummary[], known: Map<string, ChatThread>): Promise<number> {
  const days = Number(ctx.store.getSetting("chat_followup_days") ?? FOLLOWUP_DAYS_DEFAULT);
  if (!Number.isFinite(days) || days <= 0) return 0;
  let sent = 0;
  let tried = 0; // every candidate costs a page read, sent or not
  for (const t of rest) {
    if (tried >= FOLLOWUP_PER_POLL) break;
    const prev = known.get(t.negotiationId);
    if (!prev || ctx.store.getSetting(`followup_closed:${prev.id}`)) continue;
    if (!followupDue(prev, t, ctx.store.listChatMessages(prev.id), ctx.now(), days)) continue;
    ctx.checkAbort();
    tried++;
    const employer = prev.employer || t.employer;
    if (ctx.req.dryRun) {
      ctx.log.info("chats", `${employer}: silent ${days}+ days, would send a follow-up [dry-run]`, { thread_id: prev.id });
      continue;
    }
    try {
      const detail = await ctx.hh.readThread(s, t.chatUrl);
      ctx.store.insertChatMessages(prev.id, detail.messages);
      // The page may know more than the list: a closed chat or a rejection never gets a follow-up; a fresh
      // employer message fails followupDue and goes to the main loop on the next poll.
      if (detail.writable === false || detail.thread.state === "rejected") ctx.store.setSetting(`followup_closed:${prev.id}`, ctx.now().toISOString());
      if (detail.writable === false || detail.thread.state === "rejected" || !followupDue(prev, t, ctx.store.listChatMessages(prev.id), ctx.now(), days)) {
        await ctx.throttle.afterRead();
        continue;
      }
      await ctx.hh.sendMessage(s, t.chatUrl, FOLLOW_UP);
      ctx.store.insertChatMessages(prev.id, [{ hhMessageId: null, direction: "out", author: "me", text: FOLLOW_UP, isQuestion: false, answered: true }]);
      u.stats.chatReply();
      sent++;
      ctx.log.info("chats", `${employer}: silent ${days}+ days, sent a follow-up`, { thread_id: prev.id });
      await ctx.throttle.afterMutation();
    } catch (e) {
      if (e instanceof RunAbortError || isStop(e)) throw e;
      ctx.log.warn("chats", `${employer}: follow-up failed: ${errMessage(e)}`, { thread_id: prev.id });
    }
  }
  return sent;
}

/** Prep brief on an invitation: saved on the thread and sent to Telegram. Never fails the poll. */
export async function sendInterviewPrep(ctx: RunContext, u: UserRun, threadId: number, employer: string, vacancy: Vacancy | null, invitation: string): Promise<void> {
  if (!vacancy || ctx.req.dryRun) return;
  try {
    const prep = await ctx.llm.interviewPrep(ctx.store.getProfile(u.user.id) ?? u.profile, vacancy, invitation);
    u.stats.llmCall();
    ctx.store.setChatPrep(threadId, prep);
    const market = marketLine(ctx.store, u.user.id, vacancy);
    await alertWithStudy(ctx.deps.notifier, `📝 Подготовка: ${employer} (${vacancy.title})`, market ? `${formatPrep(prep).slice(0, 3350)}\n\n${market}` : formatPrep(prep), threadId);
  } catch (e) {
    ctx.log.warn("chats", `${employer}: interview prep failed: ${errMessage(e)}`, { thread_id: threadId });
  }
}

export function formatPrep(p: InterviewPrep): string {
  const block = (title: string, xs: string[]) => (xs.length ? `${title}\n${xs.map((x) => `• ${x}`).join("\n")}` : "");
  return [
    block("Вероятные вопросы:", p.questions),
    block("Что рассказать:", p.stories.map((s) => `${s.skill}: ${s.prompt}`)),
    block("Пробелы и как ответить:", p.gaps),
    block("Спросить у них:", p.ask_them),
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 3500);
}

/** Telegram ping for interviews starting within REMIND_BEFORE_MS; each time is reminded once. */
export async function remindInterviews(store: Store, notifier: Notifier, tz: string, now = new Date()): Promise<void> {
  const due = store.claimInterviewReminders(now.toISOString(), new Date(now.getTime() + REMIND_BEFORE_MS).toISOString());
  for (const t of due) {
    const at = new Date(t.interviewAt!);
    const min = Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000));
    const v = t.vacancyId === null ? null : store.getVacancy(t.vacancyId);
    await notifier
      .alert(`⏰ Через ${min} мин собеседование: ${t.employer}`, `${shortStamp(at, tz)}${v ? ` · ${v.title}` : ""}\n${HH_ORIGIN}/applicant/negotiations/item?id=${t.hhNegotiationId}`)
      .catch(() => undefined);
  }
}

/** Salary band for the seeker's own negotiation, over postings this user's CV direction was matched to.
 * "" when the direction is unknown or there are too few postings. Never goes to the employer. */
export function marketLine(store: Pick<Store, "lastApplication" | "salaryBand">, userId: number, vacancy: Pick<Vacancy, "id">): string {
  const a = store.lastApplication(userId, vacancy.id);
  const direction = a?.direction || a?.llmDecision?.direction || "";
  const band = direction ? store.salaryBand({ userId, direction }) : null;
  return band ? `💰 Рынок (${direction}, вилки в вакансиях за 90 дней): ${formatBand(band)}` : "";
}

export const OUTCOME_LABEL: Record<InterviewOutcome, string> = { next: "прошёл дальше", rejected: "отказ", silence: "тишина", offer: "оффер" };
/** Ask from 20 h after the interview (results rarely come same-day) until 3 days after. */
const ASK_AFTER_MS = 20 * 3600_000;
const ASK_UNTIL_MS = 3 * 86_400_000;

/** One «как прошло?» Telegram question per interview time, with one button per outcome. */
export async function askOutcomes(store: Store, notifier: Notifier, now = new Date()): Promise<void> {
  if (!notifier.ask) return; // no buttons (Telegram off): keep the threads unasked
  const due = store.claimOutcomeAsks(new Date(now.getTime() - ASK_UNTIL_MS).toISOString(), new Date(now.getTime() - ASK_AFTER_MS).toISOString());
  for (const t of due)
    await notifier
      .ask(`Как прошло собеседование в ${t.employer}?`, INTERVIEW_OUTCOMES.map((o) => ({ text: OUTCOME_LABEL[o], data: `io:${t.id}:${o}` })))
      .catch(() => undefined);
}

export function parseOutcomeCallback(data: string): { threadId: number; outcome: InterviewOutcome } | null {
  const m = /^io:(\d+):(\w+)$/.exec(data);
  return m && (INTERVIEW_OUTCOMES as readonly string[]).includes(m[2]!) ? { threadId: Number(m[1]), outcome: m[2] as InterviewOutcome } : null;
}
