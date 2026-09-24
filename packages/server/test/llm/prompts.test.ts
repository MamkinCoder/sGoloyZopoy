// Every template rendered with a full sample input, compared to test/llm/golden/*.txt.
// Regenerate with UPDATE_GOLDEN=1 pnpm --filter @sgz/server test.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createLLM, renderPrompt } from "../../src/llm/index.js";
import * as schemas from "../../src/llm/schemas.js";
import { cfg, cv, history, profile, questions, resumes, stubDir, stubEnv, vacancies } from "./fixtures.js";

const GOLDEN = fileURLToPath(new URL("./golden/", import.meta.url));
const NEVER = "Kubernetes, Kafka, RabbitMQ, ClickHouse";

function check(name: string, prompt: string, expectRules = true) {
  const file = `${GOLDEN}${name}.txt`;
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, prompt);
  expect(prompt).toBe(readFileSync(file, "utf8"));
  expect(prompt).toMatch(/## Схема ответа\n\n```json\n[\s\S]+```/);
  expect(prompt.trimEnd().endsWith("Верни только JSON.")).toBe(true);
  if (expectRules) {
    expect(prompt).toContain(NEVER);
    expect(prompt).toContain("## Правила");
  }
  expect(prompt).not.toMatch(/\{\{[^}]*\}\}/);
}

const outputs: Record<string, unknown> = {
  decide_hh: [],
  answer_questionnaire: [],
  answer_chat: { reply: "", needs_human: true, reason: "x" },
  triage_chat: { kind: "question", topics: ["Jest", "jest", "Vitest"] },
  summarize_resume: { direction: "go-backend", seniority: "middle", key_skills: [], one_line: "" },
  propose_pool_variants: [],
  tailor_cv: { cv, changes: [] },
  cover_letter_career: { cover_letter: "Здравствуйте. Готов обсудить детали." },
  interview_prep: { questions: [], stories: [], gaps: [], ask_them: [] },
  interview_study: { checklist: [{ topic: "Go", why: "x", level: "must", gap: false, study: "x" }] },
};

describe("prompt templates", () => {
  const capture = async (name: string, run: (llm: ReturnType<typeof createLLM>) => Promise<unknown>) => {
    const dir = stubDir();
    await run(createLLM(cfg, null, { env: stubEnv(dir, "valid", outputs[name]) }));
    return readFileSync(`${dir}/prompt-1.txt`, "utf8");
  };

  it("decide_hh", async () => check("decide_hh", await capture("decide_hh", (l) => l.decide({ profile, resumes, vacancies }))));
  it("answer_questionnaire", async () => check("answer_questionnaire", await capture("answer_questionnaire", (l) => l.answerQuestionnaire(profile, vacancies[0]!, questions))));
  it("answer_chat", async () => check("answer_chat", await capture("answer_chat", (l) => l.answerChat(profile, vacancies[0]!, history))));
  it("answer_chat with a knowledge-base block", async () => {
    const kb = "Навыки по теме:\n- Jest: есть опыт (историй: 1)\n- Vitest: нет в опыте, не заявлять\n\nИстории из опыта (единственный материал об опыте):\n\n### Тесты биллинга [Jest]\nЯндекс, 2022-2024\nЧто сделал: Писал unit-тесты на Jest.";
    const prompt = await capture("answer_chat", (l) => l.answerChat(profile, vacancies[0]!, history, [], kb));
    check("answer_chat_kb", prompt);
    expect(prompt).toContain("## База знаний: опыт по темам вопроса\n\nНавыки по теме:");
  });
  it("triage_chat", async () => check("triage_chat", await capture("triage_chat", (l) => l.triageChat(profile, history, history.slice(-1))), false));
  it("triage_chat keeps one entry per skill", async () => {
    const llm = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", outputs.triage_chat) });
    expect(await llm.triageChat(profile, history, history.slice(-1))).toEqual({ kind: "question", topics: ["Jest", "Vitest"] });
  });
  it("summarize_resume", async () =>
    check("summarize_resume", await capture("summarize_resume", (l) => l.summarizeResume("Go-разработчик. Опыт 2,5 года: Go, Redis, PostgreSQL, Docker. Биллинг и интеграции.")), false));
  it("propose_pool_variants", async () => check("propose_pool_variants", await capture("propose_pool_variants", (l) => l.proposePoolVariants(profile, resumes, 2))));
  it("tailor_cv", async () => check("tailor_cv", await capture("tailor_cv", (l) => l.tailorCV(profile, cv, vacancies[1]!))));
  it("cover_letter_career", async () => check("cover_letter_career", await capture("cover_letter_career", (l) => l.coverLetterCareer(profile, cv, vacancies[0]!))));

  it("interview_prep", async () => check("interview_prep", await capture("interview_prep", (l) => l.interviewPrep(profile, vacancies[0]!, "Приглашаем на техническое собеседование в четверг."))));

  it("interview_study", async () =>
    check("interview_study", await capture("interview_study", (l) => l.interviewStudy(profile, vacancies[0]!, { questions: ["Как устроен GC в Go?"], stories: [], gaps: ["Kafka: в продакшене не использовал"], ask_them: [] }))));

  it("site_onboard and pick_element render via renderPrompt", () => {
    check("site_onboard", renderPrompt("site_onboard", { url: "https://example.com/careers", hints: "", page_text: "Careers at Example. Open roles: Backend Engineer (Go). Powered by Lever. jobs.lever.co/example" }), false);
    check(
      "pick_element",
      renderPrompt("pick_element", { goal: "Нажать кнопку отклика на вакансию", context: "Страница вакансии Go-разработчик", elements: "[0] a «Войти»\n[1] button «Откликнуться»\n[2] a «Похожие вакансии»" }),
      false,
    );
  });

  it("every zod schema converts to JSON schema for --json-schema", () => {
    for (const [name, s] of Object.entries(schemas)) {
      if (name === "unwrapArray") continue;
      expect(() => z.toJSONSchema(s as z.ZodType, { io: "output" }), name).not.toThrow();
    }
  });
});
