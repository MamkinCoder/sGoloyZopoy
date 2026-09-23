// Mock interview in Telegram, seeded from the prep brief of an invited chat (chat_threads.prep_json).
// One session per Telegram chat in setting `mock:<chatId>` (no table); it expires after 2 h of silence.
// The seeker answers in plain messages; each answer gets one LLM feedback call, the last one a summary.
import type { ChatThread, LLMClient, Store, User } from "@sgz/shared";
import { profileForLLM, neverClaimList, renderVacancy } from "../llm/format.js";
import { MockFeedbackSchema, MockSummarySchema } from "../llm/schemas.js";
import { renderPrompt } from "../llm/template.js";
import { errMessage } from "./util.js";

export const MOCK_TTL_MS = 2 * 3600_000;
export const MOCK_QUESTIONS = 5;
/** Extra follow-up questions per session (the interviewer digs into an answer). */
const MAX_FOLLOW_UPS = 2;

interface MockState {
  userId: number;
  threadId: number;
  employer: string;
  qs: { q: string; fu?: true }[];
  idx: number;
  transcript: { q: string; a: string; fb: string }[];
  at: string; // last activity, ISO
}

type MockStore = Pick<Store, "getSetting" | "setSetting" | "listUsers" | "listChatThreads" | "getVacancy" | "getProfile">;

const key = (chatId: string) => `mock:${chatId}`;
const busy = new Set<string>();

export function loadMock(store: MockStore, chatId: string, now: Date): MockState | null {
  const raw = store.getSetting(key(chatId));
  if (!raw) return null;
  try {
    const st = JSON.parse(raw) as MockState;
    return now.getTime() - Date.parse(st.at) < MOCK_TTL_MS ? st : null;
  } catch {
    return null;
  }
}
const save = (store: MockStore, chatId: string, st: MockState | null) => store.setSetting(key(chatId), st ? JSON.stringify(st) : "");

/** A user's own chat sees only their threads; the admin chat sees every active user's. */
function usersFor(store: MockStore, chatId: string): User[] {
  const all = store.listUsers(true);
  const own = all.filter((u) => u.tgChatId === chatId);
  return own.length ? own : all;
}

/** /mock [employer]: the most recent thread with a prep brief (optionally matching the employer). */
export function startMock(store: MockStore, chatId: string, employer: string, now: Date): string {
  const q = employer.trim().toLowerCase();
  const threads: ChatThread[] = usersFor(store, chatId)
    .flatMap((u) => store.listChatThreads(u.id))
    .filter((t) => t.prep?.questions.length && (!q || t.employer.toLowerCase().includes(q)))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const t = threads[0];
  if (!t) return q ? `Нет приглашения с подготовкой для «${employer.trim()}».` : "Пока нет приглашений с подготовкой: тренировка появится после первого приглашения.";
  const st: MockState = {
    userId: t.userId,
    threadId: t.id,
    employer: t.employer,
    qs: t.prep!.questions.slice(0, MOCK_QUESTIONS).map((x) => ({ q: x })),
    idx: 0,
    transcript: [],
    at: now.toISOString(),
  };
  save(store, chatId, st);
  return `Тренировка: ${t.employer}. ${st.qs.length} вопросов, отвечай обычным сообщением, /stop - закончить.\n\nВопрос 1: ${st.qs[0]!.q}`;
}

export function stopMock(store: MockStore, chatId: string, now: Date): string {
  const had = loadMock(store, chatId, now);
  save(store, chatId, null);
  return had ? `Тренировка остановлена после ${had.transcript.length} ответов.` : "Тренировки сейчас нет.";
}

function llmInputs(store: MockStore, st: MockState) {
  const profile = store.getProfile(st.userId);
  const thread = store.listChatThreads(st.userId).find((t) => t.id === st.threadId);
  const vacancy = thread?.vacancyId != null ? store.getVacancy(thread.vacancyId) : null;
  return {
    never_claim: profile ? neverClaimList(profile) : "(список пуст)",
    profile: profile ? profileForLLM(profile) : {},
    vacancy: vacancy ? renderVacancy(vacancy, 3000) : `Работодатель: ${st.employer} (текст вакансии не сохранён)`,
  };
}

/** A plain message from `chatId`: the answer to the current question, or null when no session is active. */
export async function mockAnswer(store: MockStore, llm: LLMClient, chatId: string, text: string, now: Date): Promise<string | null> {
  const st = loadMock(store, chatId, now);
  if (!st) return null;
  if (busy.has(chatId)) return "Секунду, разбираю прошлый ответ.";
  busy.add(chatId);
  try {
    const inputs = llmInputs(store, st);
    const cur = st.qs[st.idx]!;
    const answer = text.trim().slice(0, 3000);
    const raw = await llm.json(
      "mock_feedback",
      "write",
      renderPrompt("mock_feedback", { ...inputs, question: cur.q, answer }),
      '```json\n{ "feedback": string, "follow_up": string | null }\n```',
    );
    const fb = MockFeedbackSchema.parse(raw);
    const feedback = fb.feedback.trim().slice(0, 500);
    st.transcript.push({ q: cur.q, a: answer, fb: feedback });
    if (fb.follow_up?.trim() && !cur.fu && st.qs.filter((x) => x.fu).length < MAX_FOLLOW_UPS) st.qs.splice(st.idx + 1, 0, { q: fb.follow_up.trim(), fu: true });
    st.idx++;
    st.at = now.toISOString();
    const next = st.qs[st.idx];
    if (next) {
      save(store, chatId, st);
      return `${feedback}\n\n${next.fu ? "Уточнение" : `Вопрос ${st.qs.slice(0, st.idx + 1).filter((x) => !x.fu).length}`}: ${next.q}`;
    }
    save(store, chatId, null);
    return `${feedback}\n\n${await summary(llm, inputs, st)}`;
  } catch (e) {
    return `Не получилось разобрать ответ (${errMessage(e).slice(0, 120)}). Отправь его ещё раз или /stop.`;
  } finally {
    busy.delete(chatId);
  }
}

async function summary(llm: LLMClient, inputs: ReturnType<typeof llmInputs>, st: MockState): Promise<string> {
  const transcript = st.transcript.map((t, i) => `${i + 1}. Вопрос: ${t.q}\nОтвет: ${t.a}\nРазбор: ${t.fb}`).join("\n\n");
  try {
    const raw = await llm.json("mock_summary", "write", renderPrompt("mock_summary", { ...inputs, transcript }), '```json\n{ "tighten": string[] }\n```');
    const tighten = MockSummarySchema.parse(raw).tighten.map((x) => x.trim()).filter(Boolean).slice(0, 3);
    return tighten.length ? `Тренировка закончена. Что подтянуть:\n${tighten.map((x) => `• ${x}`).join("\n")}` : "Тренировка закончена.";
  } catch {
    return "Тренировка закончена.";
  }
}
