// Interview study pack, built only on a button press («📚 Чеклист к собеседованию», /study, the panel):
// an LLM checklist of what the interviewer will likely ask + a ChatGPT tutor prompt built here, in code.
// Not a runner job: no browser, just one `claude -p` through app.llm (the global claude mutex serializes it).
import type { ChatThread, LLMClient, Notifier, Profile, Store, StudyItem, StudyPack, Vacancy } from "@sgz/shared";
import { chunkMessage, escapeHtml, formatAlert } from "../notify/format.js";
import { usersFor } from "./mock.js";
import { errMessage } from "./util.js";
import { stripHtml } from "../career/http.js";

export const STUDY_TTL_MS = 7 * 86_400_000;
export const STUDY_PROMPT_MAX = 12_000;
const DESC_MAX = 3000;

export const studyButton = (threadId: number) => ({ text: "📚 Чеклист к собеседованию", data: `st:${threadId}` });
const regenButton = (threadId: number) => ({ text: "🔄 Пересобрать", data: `st:${threadId}:r` });

export function parseStudyCallback(data: string): { threadId: number; regen: boolean } | null {
  const m = /^st:(\d+)(:r)?$/.exec(data);
  return m ? { threadId: Number(m[1]), regen: !!m[2] } : null;
}

// Personal contacts and links never go into a text the seeker pastes into a third-party chat.
const CONTACT_RE =
  /https?:\/\/\S+|www\.\S+|t\.me\/\S*|[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}|@[a-z0-9_]{4,}|\+\d[\d\s()-]{8,}\d|\b8[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/gi;
const scrub = (s: string, p: Pick<Profile, "email" | "phone" | "telegram">): string =>
  [p.email, p.phone, p.telegram].filter((x) => x.trim().length > 3).reduce((acc, x) => acc.split(x.trim()).join(""), s).replace(CONTACT_RE, "");

const LEVEL_LABEL: Record<StudyItem["level"], string> = { must: "Обязательно", likely: "Скорее всего", nice: "Плюсом" };

/** The ChatGPT tutor prompt, in Russian, under STUDY_PROMPT_MAX, without contacts or links. */
export function buildStudyPrompt(v: Pick<Vacancy, "title" | "company" | "descriptionText">, profile: Profile, checklist: StudyItem[]): string {
  const clean = (s: string) => scrub(s, profile).replace(/[ \t]+/g, " ").trim();
  const list = checklist
    .map((it, i) => `${i + 1}. [${LEVEL_LABEL[it.level]}] ${it.topic}${it.gap ? " (пробел - нужно подтянуть)" : ""}${it.study ? `. Что повторить: ${it.study}` : ""}`)
    .join("\n");
  const experience = [profile.experience && `Стаж: ${profile.experience}.`, profile.summary.slice(0, 1500)].filter(Boolean).join(" ");
  const render = (desc: string) =>
    clean(
      [
        "Ты - мой наставник по подготовке к техническому собеседованию.",
        `Позиция: ${v.title} в ${v.company || "компании"}.`,
        `Описание вакансии:\n${desc || "(нет текста)"}`,
        `Мой опыт: ${experience || "(не указан)"}`,
        profile.verified_skills.length ? `Мой реальный стек: ${profile.verified_skills.join(", ")}.` : "",
        profile.never_claim_skills.length ? `В продакшене не использовал: ${profile.never_claim_skills.join(", ")}.` : "",
        `Что, скорее всего, спросят (чеклист):\n${list}`,
        "Как работаем: начни с пробелов, объясняй кратко с примерами, затем задавай мне вопросы по одному в формате собеседования, оценивай ответ и поправляй, в конце каждой темы - 2-3 задачи для практики. Отвечай по-русски.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  // hh stores the description as HTML: the tutor gets plain text.
  const desc = stripHtml(v.descriptionText);
  const room = Math.max(0, Math.min(DESC_MAX, STUDY_PROMPT_MAX - render("").length - 10));
  return render(desc.length > room ? `${desc.slice(0, room).trimEnd()}…` : desc).slice(0, STUDY_PROMPT_MAX);
}

/** Telegram HTML: groups by level, gaps marked 📌, one line per topic. */
export function formatChecklist(p: StudyPack): string {
  const groups = (["must", "likely", "nice"] as const)
    .map((lvl) => {
      const xs = p.checklist.filter((it) => it.level === lvl);
      return xs.length
        ? `<b>${LEVEL_LABEL[lvl]}</b>\n${xs.map((it) => `• ${it.gap ? "📌 " : ""}<b>${escapeHtml(it.topic)}</b>${it.study ? ` - ${escapeHtml(it.study)}` : ""}`).join("\n")}`
        : "";
    })
    .filter(Boolean);
  return [
    `📚 <b>Чеклист к собеседованию</b>\n${escapeHtml(p.vacancyTitle)} · ${escapeHtml(p.company)}\n📌 - пробел, нужно подтянуть`,
    ...groups,
    "Ниже промпт для ChatGPT: нажми на него, чтобы скопировать.",
  ].join("\n\n");
}

/** Escaped text in <pre> blocks of at most `max` chars each, split on lines, never inside an entity. */
export function preChunks(text: string, max = 4096): string[] {
  const room = max - "<pre></pre>".length;
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur) out.push(`<pre>${cur}</pre>`);
    cur = "";
  };
  for (const raw of text.split("\n")) {
    const e = escapeHtml(raw);
    const sep = cur ? "\n" : "";
    if (cur.length + sep.length + e.length <= room) {
      cur += sep + e;
      continue;
    }
    push();
    if (e.length <= room) cur = e;
    else
      for (const ch of raw) {
        const ec = escapeHtml(ch);
        if (cur.length + ec.length > room) push();
        cur += ec;
      }
  }
  push();
  return out;
}

/** Checklist (with «Пересобрать» on its last part), then the tap-to-copy prompt. */
export async function deliverStudy(notifier: Notifier, pack: StudyPack, threadId: number): Promise<void> {
  if (!notifier.ask) return;
  const parts = chunkMessage(formatChecklist(pack));
  for (const [i, part] of parts.entries()) await notifier.ask(part, i === parts.length - 1 ? [regenButton(threadId)] : []);
  for (const part of preChunks(pack.prompt)) await notifier.ask(part, []);
}

/** Alert with the study button on its last part; a plain alert when the notifier has no buttons. */
export async function alertWithStudy(notifier: Notifier, title: string, body: string, threadId: number): Promise<void> {
  if (!notifier.ask) return notifier.alert(title, body);
  const parts = chunkMessage(formatAlert(title, body));
  for (const [i, part] of parts.entries()) await notifier.ask(part, i === parts.length - 1 ? [studyButton(threadId)] : []);
}

type StudyStore = Pick<Store, "listUsers" | "listChatThreads" | "getVacancy" | "getProfile" | "setChatStudy">;

export function findThread(store: Pick<Store, "listUsers" | "listChatThreads">, id: number): ChatThread | null {
  for (const u of store.listUsers()) {
    const t = store.listChatThreads(u.id).find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}

// ponytail: in-process registry, fine for one serve process; a restart forgets running builds (the tap is repeatable).
const running = new Map<number, Promise<StudyPack>>();
const failures = new Map<number, string>();

export const studyStatus = (threadId: number) => ({ generating: running.has(threadId), error: failures.get(threadId) ?? "" });

/** Builds and stores the pack; a second call for the same thread while one runs gets the same promise. */
export function startStudy(store: StudyStore, llm: LLMClient, threadId: number, now = new Date()): Promise<StudyPack> {
  const cur = running.get(threadId);
  if (cur) return cur;
  failures.delete(threadId);
  const job = (async () => {
    const t = findThread(store, threadId);
    const v = t?.vacancyId != null ? store.getVacancy(t.vacancyId) : null;
    const profile = t ? store.getProfile(t.userId) : null;
    if (!t || !v || !profile) throw new Error(!t ? "диалог не найден" : !v ? "у диалога нет вакансии" : "нет профиля");
    const checklist = await llm.interviewStudy(profile, v, t.prep ?? null);
    if (!checklist.length) throw new Error("LLM вернул пустой чеклист");
    const pack: StudyPack = { checklist, prompt: buildStudyPrompt(v, profile, checklist), at: now.toISOString(), vacancyTitle: v.title, company: v.company || t.employer };
    store.setChatStudy(threadId, pack);
    return pack;
  })();
  running.set(threadId, job);
  job.catch((e: unknown) => failures.set(threadId, errMessage(e))).finally(() => running.delete(threadId));
  return job;
}

export interface StudyDeps {
  store: StudyStore;
  llm: LLMClient;
  notifier: Notifier;
}

/** Telegram tap / command: resend a fresh pack, or build one in the background. Returns the tap note. */
export function studyTap(d: StudyDeps, cb: { threadId: number; regen: boolean }, now = new Date()): string {
  const t = findThread(d.store, cb.threadId);
  if (!t) return "диалог не найден";
  const warn = (e: unknown) => d.notifier.alert("📚 Чеклист не собрался", `${t.employer}: ${errMessage(e)}`).catch(() => undefined);
  if (t.study && !cb.regen && now.getTime() - Date.parse(t.study.at) < STUDY_TTL_MS) {
    void deliverStudy(d.notifier, t.study, t.id).catch(warn);
    return "чеклист уже есть, отправляю";
  }
  if (t.vacancyId === null) return "у диалога нет вакансии, чеклист не из чего собрать";
  if (running.has(t.id)) return "уже готовлю чеклист…";
  void startStudy(d.store, d.llm, t.id, now)
    .then((p) => deliverStudy(d.notifier, p, t.id))
    .catch(warn);
  return "готовлю чеклист…";
}

/** /study [компания]: the most recent invited / needs_human thread with a vacancy. */
export function studyCommand(d: StudyDeps, chatId: string, args: string, now = new Date()): string {
  const q = args.trim().toLowerCase();
  const t = usersFor(d.store, chatId)
    .flatMap((u) => d.store.listChatThreads(u.id))
    .filter((x) => (x.state === "invited" || x.state === "needs_human") && x.vacancyId !== null)
    .filter((x) => !q || x.employer.toLowerCase().includes(q) || (d.store.getVacancy(x.vacancyId!)?.company ?? "").toLowerCase().includes(q))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  if (!t) return q ? `Нет приглашения с вакансией для «${args.trim()}».` : "Пока нет приглашений с вакансией: чеклист появится после первого приглашения.";
  return `${t.employer}: ${studyTap(d, { threadId: t.id, regen: false }, now)}`;
}
