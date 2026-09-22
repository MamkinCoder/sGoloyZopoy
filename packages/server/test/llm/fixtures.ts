// Deterministic sample inputs shared by the llm tests and the golden prompts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CV, ChatMessage, Config, HHResume, LLMCall, Profile, Question, Store, Vacancy } from "@sgz/shared";

export const STUB_BIN = fileURLToPath(new URL("./claude-stub.sh", import.meta.url));
export const REPO_DIR = fileURLToPath(new URL("../../../..", import.meta.url));

export function stubDir(): string {
  return mkdtempSync(join(tmpdir(), "sgz-llm-"));
}

export function stubEnv(dir: string, mode: string, result: unknown = {}, extra: Record<string, string> = {}): Record<string, string> {
  return { STUB_DIR: dir, STUB_MODE: mode, STUB_RESULT: typeof result === "string" ? result : JSON.stringify(result), ...extra };
}

export const cfg: Config = {
  dataDir: "/tmp/sgz-data",
  repoDir: REPO_DIR,
  bind: { host: "127.0.0.1", port: 3002 },
  panelPassword: "",
  panelUrl: "",
  tgBotToken: "",
  tgChatId: "",
  chromiumBin: "",
  claudeBin: STUB_BIN,
  xelatexBin: "xelatex",
  scheduleAt: "",
  scheduleJitterMin: 0,
  tz: "Europe/Moscow",
  runnerEnabled: false,
  throttleMinMs: 0,
  throttleMaxMs: 0,
  userAgent: "test",
  memoryGuardMB: 450,
};

export const profile: Profile = {
  full_name: "Ярослав Тестов",
  email: "test@example.com",
  phone: "+7 900 000-00-00",
  telegram: "@testhandle",
  city: "Санкт-Петербург",
  citizenship: "РФ",
  relocation: "готов к переезду",
  work_formats: ["remote", "hybrid"],
  salary_from: 0,
  salary_to: 0,
  currency: "RUR",
  experience: "2,5 года коммерческого опыта",
  languages: ["русский - родной", "английский - C1"],
  directions: ["go-backend", "node-backend", "react", "fullstack"],
  summary: "Backend-разработчик, основной язык Go. Интеграции поверх внешних API, биллинг и подписки, Redis, CI/CD. Также Node.js/TypeScript и React.",
  verified_skills: ["Go", "TypeScript", "Node.js", "React", "Redis", "Docker", "CI/CD", "PostgreSQL", "Linux"],
  never_claim_skills: ["Kubernetes", "Kafka", "RabbitMQ", "ClickHouse"],
  hh_queries: ["Go разработчик"],
  hh_area: "",
  exclude_words: ["Senior"],
  company_blacklist: [],
  extra: { "готовность к командировкам": "да", "когда готов выйти": "в течение 2 недель" },
};

const resume = (id: number, hhId: string, title: string, direction: string, skills: string[]): HHResume => ({
  id,
  userId: 1,
  hhResumeId: hhId,
  title,
  url: `https://hh.ru/resume/${hhId}`,
  direction,
  summary: { direction, seniority: "middle", key_skills: skills, one_line: `${title}, 2.5 года` },
  isGenerated: false,
  syncedAt: "2026-09-01T10:00:00Z",
});

export const resumes: HHResume[] = [
  resume(1, "aaa111", "Go-разработчик", "go-backend", ["Go", "Redis", "PostgreSQL", "Docker"]),
  resume(2, "bbb222", "Node.js-разработчик", "node-backend", ["Node.js", "TypeScript", "PostgreSQL"]),
  resume(3, "ccc333", "Fullstack-разработчик", "fullstack", ["React", "Node.js", "TypeScript"]),
];

export function vacancy(id: number, over: Partial<Vacancy> = {}): Vacancy {
  return {
    id,
    source: "hh",
    externalId: String(1000 + id),
    url: `https://hh.ru/vacancy/${1000 + id}`,
    title: `Go-разработчик ${id}`,
    company: `Компания ${id}`,
    salaryFrom: 150000,
    salaryTo: 250000,
    currency: "RUR",
    descriptionText: `Ищем Go-разработчика в команду платежей. Нужен опыт с Go, PostgreSQL, Redis, Docker. Плюсом будет Kafka. Задачи: интеграции с внешними API, биллинг, мониторинг. Вакансия номер ${id}.`,
    hasTest: false,
    requiresLetter: true,
    area: "Москва",
    workFormat: "remote",
    publishedAt: "2026-09-20T09:00:00Z",
    firstSeenAt: "2026-09-21T09:00:00Z",
    lastSeenAt: "2026-09-22T09:00:00Z",
    archived: false,
    dedupHash: `hash-${id}`,
    ...over,
  };
}

export const vacancies: Vacancy[] = [
  vacancy(1),
  vacancy(2, { title: "Senior Go Developer", company: "BigCorp", descriptionText: "Senior Go Developer, 6+ years required. Kubernetes, Kafka, gRPC. We build a high-load trading platform. English-speaking team, remote across Europe. Responsibilities include system design and mentoring." }),
  vacancy(3, { title: "Frontend-разработчик (React)", company: "Студия", descriptionText: "React, TypeScript, Redux. Верстка адаптивных интерфейсов, работа с REST API, code review.", salaryFrom: 0, salaryTo: 0 }),
];

export const questions: Question[] = [
  { idx: 0, text: "Готовы ли вы к командировкам?", kind: "radio", options: ["Да", "Нет", "Иногда"], required: true },
  { idx: 1, text: "Какие языки программирования используете?", kind: "checkbox", options: ["Go", "PHP", "TypeScript", "Kotlin"], required: true },
  { idx: 2, text: "Расскажите об опыте с Redis", kind: "text", required: false },
  { idx: 3, text: "Ожидаемая зарплата", kind: "number", required: false },
  { idx: 4, text: "Прикрепите резюме", kind: "file", required: false },
];

export const history: ChatMessage[] = [
  { id: 1, threadId: 1, hhMessageId: "m1", direction: "in", author: "employer", text: "Здравствуйте! Спасибо за отклик. Подскажите, сколько лет работаете с Go?", isQuestion: true, answered: false, createdAt: "2026-09-22T10:00:00Z" },
  { id: 2, threadId: 1, hhMessageId: "m2", direction: "out", author: "me", text: "Здравствуйте. Около двух лет в коммерческой разработке.", isQuestion: false, answered: true, createdAt: "2026-09-22T10:05:00Z" },
  { id: 3, threadId: 1, hhMessageId: "m3", direction: "in", author: "employer", text: "Отлично. А с Kubernetes работали? И готовы ли к удалёнке?", isQuestion: true, answered: false, createdAt: "2026-09-22T10:10:00Z" },
];

export const cv: CV = {
  title: "Backend-разработчик",
  name: "Ярослав Тестов",
  contacts: { email: "test@example.com", phone: "+7 900 000-00-00", telegram: "@testhandle", github: "github.com/testhandle", city: "Санкт-Петербург" },
  about: "Backend-разработчик на Go и Node.js. Делал интеграции, биллинг, кэширование.",
  skills: [
    { name: "Языки", items: ["Go", "TypeScript"] },
    { name: "Инфраструктура", items: ["Docker", "Redis", "PostgreSQL", "CI/CD"] },
  ],
  jobs: [
    {
      company: "Финтех ООО",
      role: "Backend-разработчик",
      period: "2024 - н.в.",
      location: "удалённо",
      summary: "Платёжный сервис.",
      bullets: ["Сделал интеграцию с ЮKassa и рекуррентные подписки", "Вынес кэш сессий в Redis, снизил нагрузку на PostgreSQL", "Настроил CI/CD на GitHub Actions"],
      stack: ["Go", "PostgreSQL", "Redis", "Docker"],
    },
    {
      company: "Веб-студия",
      role: "Fullstack-разработчик",
      period: "2023 - 2024",
      location: "Санкт-Петербург",
      summary: "Сайты и админки.",
      bullets: ["Писал REST API на Node.js/TypeScript", "Делал интерфейсы на React"],
      stack: ["Node.js", "TypeScript", "React"],
    },
  ],
  education: [{ institution: "ИТМО", degree: "Информационная безопасность", period: "2020 - 2023", note: "неоконченное" }],
};

/** Minimal Store: only insertLLMCall is real; everything else throws if touched. */
export function fakeStore(): Store & { llmCalls: LLMCall[] } {
  const llmCalls: LLMCall[] = [];
  const boom = () => {
    throw new Error("not implemented in fake store");
  };
  return new Proxy({ llmCalls } as Store & { llmCalls: LLMCall[] }, {
    get(target, prop) {
      if (prop === "llmCalls") return target.llmCalls;
      if (prop === "insertLLMCall") return (c: LLMCall) => target.llmCalls.push(c);
      return boom;
    },
  });
}
