import type { RunStatus, Status, ThreadState } from "@sgz/shared";

export type Family = "sent" | "skip" | "failed" | "human";

export function familyOf(status: string): Family {
  if (status === "SENT") return "sent";
  if (status.startsWith("SKIP_")) return "skip";
  if (status.startsWith("FAILED_")) return "failed";
  return "human";
}

export const STATUS_LABEL: Record<Status, string> = {
  SENT: "Отправлен",
  SKIP_ALREADY_APPLIED: "Уже откликались",
  SKIP_TEST_REQUIRED: "Нужен тест",
  SKIP_LLM_REJECT: "LLM отклонил",
  SKIP_DEDUP: "Дубликат",
  SKIP_LIMIT: "Лимит",
  SKIP_DRY_RUN: "Dry-run",
  SKIP_FILTER: "Фильтр",
  SKIP_ARCHIVED: "В архиве",
  SKIP_FOREIGN: "Другая страна",
  FAILED_NO_CONFIRMATION: "Нет подтверждения",
  FAILED_UI: "Ошибка UI",
  FAILED_ANTI_BOT: "Анти-бот",
  FAILED_CAPTCHA: "Капча",
  FAILED_LOGIN_EXPIRED: "Сессия истекла",
  FAILED_LOW_MEMORY: "Мало памяти",
  FAILED_LLM: "Ошибка LLM",
  FAILED_LATEX: "Ошибка LaTeX",
  NEEDS_HUMAN: "Нужен человек",
};

// Keep this list local so the browser does not load the shared runtime barrel.
// That barrel also exports server-only modules (including node:crypto).
export const ALL_STATUSES: Status[] = [
  "SENT",
  "SKIP_ALREADY_APPLIED",
  "SKIP_TEST_REQUIRED",
  "SKIP_LLM_REJECT",
  "SKIP_DEDUP",
  "SKIP_LIMIT",
  "SKIP_DRY_RUN",
  "SKIP_FILTER",
  "SKIP_ARCHIVED",
  "SKIP_FOREIGN",
  "FAILED_NO_CONFIRMATION",
  "FAILED_UI",
  "FAILED_ANTI_BOT",
  "FAILED_CAPTCHA",
  "FAILED_LOGIN_EXPIRED",
  "FAILED_LOW_MEMORY",
  "FAILED_LLM",
  "FAILED_LATEX",
  "NEEDS_HUMAN",
];

export const STATUS_GROUPS: { label: string; family: Family; items: Status[] }[] = [
  { label: "Отправлено", family: "sent", items: ALL_STATUSES.filter((s) => familyOf(s) === "sent") },
  { label: "Пропущено", family: "skip", items: ALL_STATUSES.filter((s) => familyOf(s) === "skip") },
  { label: "Ошибки", family: "failed", items: ALL_STATUSES.filter((s) => familyOf(s) === "failed") },
  { label: "Нужен человек", family: "human", items: ALL_STATUSES.filter((s) => familyOf(s) === "human") },
];

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "В очереди",
  running: "Выполняется",
  done: "Завершён",
  failed: "Ошибка",
  stopped: "Остановлен",
};

export const THREAD_STATE_LABEL: Record<ThreadState, string> = {
  new: "новое",
  viewed: "просмотрено",
  invited: "приглашение",
  rejected: "отказ",
  archived: "архив",
  needs_human: "нужен человек",
};

export const SOURCE_LABEL: Record<string, string> = { hh: "hh.ru", career: "Сайты", all: "Все", pool: "Пул резюме" };
export const TRIGGER_LABEL: Record<string, string> = { schedule: "по расписанию", manual: "вручную", cli: "CLI" };
export const STAGE_LABEL: Record<string, string> = {
  session: "Сессия",
  pool: "Пул резюме",
  search: "Поиск",
  fetch: "Загрузка",
  decide: "Решение",
  apply: "Отклики",
  chats: "Чаты",
  touch: "Поднятие",
  discover: "Обход сайтов",
  tailor: "Адаптация резюме",
  build: "Сборка PDF",
  report: "Отчёт",
};

export const isRunActive = (s: RunStatus | undefined) => s === "running" || s === "queued";
