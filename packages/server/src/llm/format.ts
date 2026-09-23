// Renders domain objects into the plain-text blocks the prompt templates expect.
import type { ChatMessage, HHResume, Profile, Question, Vacancy } from "@sgz/shared";

const DESCRIPTION_MAX = 3000;

/** Profile as the model may see it. Contacts are dropped unless a form needs them. */
export function profileForLLM(p: Profile, opts: { contacts?: boolean } = {}): Record<string, unknown> {
  const { email, phone, telegram, hh_queries: _q, hh_area: _a, exclude_words: _e, company_blacklist: _b, known_companies: _k, ...rest } = p;
  return opts.contacts ? { ...rest, email, phone, telegram } : rest;
}

export function neverClaimList(p: Profile): string {
  return p.never_claim_skills.length ? p.never_claim_skills.join(", ") : "(список пуст)";
}

function isEnglish(text: string): boolean {
  const latin = (text.match(/[a-z]/gi) ?? []).length;
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  return latin > cyr * 2 && latin > 40;
}

export function renderVacancy(v: Vacancy, maxDesc = DESCRIPTION_MAX): string {
  const salary = v.salaryFrom || v.salaryTo ? `${v.salaryFrom || "?"}-${v.salaryTo || "?"} ${v.currency}`.trim() : "не указана";
  const meta = [
    `Зарплата: ${salary}`,
    v.workFormat ? `Формат: ${v.workFormat}` : "",
    v.area ? `Регион: ${v.area}` : "",
    `Тестовое: ${v.hasTest ? "да" : "нет"}`,
    `Письмо обязательно: ${v.requiresLetter ? "да" : "нет"}`,
    `Язык вакансии: ${isEnglish(v.descriptionText) ? "английский" : "русский"}`,
  ]
    .filter(Boolean)
    .join(" | ");
  const desc = v.descriptionText.replace(/\s+\n/g, "\n").trim();
  const cut = desc.length > maxDesc ? `${desc.slice(0, maxDesc).trimEnd()} …` : desc;
  return `### [id=${v.id}] ${v.title} - ${v.company}\n${meta}\nОписание:\n${cut}`;
}

export function renderVacancies(vs: Vacancy[]): string {
  return vs.map((v) => renderVacancy(v)).join("\n\n");
}

export function renderResumes(rs: HHResume[]): string {
  if (!rs.length) return "(пул пуст)";
  return rs
    .map((r) => {
      const s = r.summary;
      const parts = [`resume_id: "${r.hhResumeId}"`, `название: ${r.title}`, `direction: ${r.direction || s?.direction || "?"}`];
      if (s) {
        if (s.seniority) parts.push(`seniority: ${s.seniority}`);
        if (s.key_skills.length) parts.push(`key_skills: ${s.key_skills.join(", ")}`);
        if (s.one_line) parts.push(s.one_line);
      }
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}

export function renderQuestions(qs: Question[]): string {
  return qs
    .map((q) => {
      const opts = q.options?.length ? `\n  варианты: ${q.options.map((o, i) => `[${i}] ${o}`).join("; ")}` : "";
      return `- idx=${q.idx} (${q.kind}${q.required ? ", обязательный" : ""}): ${q.text}${opts}`;
    })
    .join("\n");
}

export function renderHistory(ms: ChatMessage[]): string {
  if (!ms.length) return "(пусто)";
  return ms.map((m) => `[${m.author === "me" ? "соискатель" : m.author === "bot" ? "бот работодателя" : "работодатель"} ${m.createdAt.slice(0, 16)}]\n${m.text.trim()}`).join("\n\n");
}
