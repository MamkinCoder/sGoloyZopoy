import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Decision } from "@sgz/shared";
import { createLLM } from "../../src/llm/index.js";
import { FakeLLM } from "../../src/llm/fake.js";
import { cfg, cv, fakeStore, history, profile, questions, resumes, stubDir, stubEnv, vacancy, vacancies } from "./fixtures.js";

const count = (dir: string) => Number(readFileSync(`${dir}/count`, "utf8"));
const decision = (id: number, over: Partial<Decision> = {}): Decision => ({
  vacancy_id: id,
  apply: true,
  reason: "подходит",
  resume_id: "aaa111",
  cover_letter: "Здравствуйте. Делал биллинг на Go. Готов обсудить детали.",
  direction: "go-backend",
  seniority: "middle",
  red_flags: [],
  ...over,
});

describe("createLLM", () => {
  it("decide: parses, validates resume ids, strips links/never_claim, fills missing", async () => {
    const dir = stubDir();
    const store = fakeStore();
    const out = [
      decision(1, { cover_letter: "Здравствуйте. Делал биллинг на Go. Мой гитхаб https://github.com/x. Настраивал Kafka в проде. Готов обсудить детали." }),
      decision(2, { apply: false, resume_id: "", cover_letter: "", reason: "Senior, 6+ лет", red_flags: ["6+ лет"] }),
    ];
    const llm = createLLM(cfg, store, { env: stubEnv(dir, "fenced", out) }).withRun(7);
    const ds = await llm.decide({ profile, resumes, vacancies });
    expect(ds).toHaveLength(3);
    expect(ds[0]!.cover_letter).toBe("Здравствуйте. Делал биллинг на Go. Готов обсудить детали.");
    expect(ds[1]).toMatchObject({ apply: false, red_flags: ["6+ лет"] });
    expect(ds[2]).toMatchObject({ vacancy_id: 3, apply: false, reason: "no decision" });
    expect(store.llmCalls).toHaveLength(1);
    expect(store.llmCalls[0]).toMatchObject({ runId: 7, task: "decide_hh", model: "sonnet", ok: true, attempt: 1, error: "" });
    expect(store.llmCalls[0]!.promptChars).toBeGreaterThan(1000);
    const prompt = readFileSync(`${dir}/prompt-1.txt`, "utf8");
    expect(prompt).toContain("Kubernetes, Kafka, RabbitMQ, ClickHouse");
    expect(prompt).toContain("[id=2] Senior Go Developer");
    expect(prompt).not.toContain("test@example.com");
  });

  it("decide: resume_fit defaults to good; tailored kept only for approved poor fit, skills ⊆ verified", async () => {
    const dir = stubDir();
    const tailored = { title: "React-разработчик", about: "Пишу на React и TypeScript. Настраивал Kafka. Код на https://x.dev. Готов.", key_skills: ["react", "TypeScript", "Kafka", "Vue"] };
    const out = [
      { ...decision(1), resume_fit: "poor", tailored },
      { ...decision(2), resume_fit: "weird", tailored },
      { ...decision(3), resume_fit: "poor" },
    ];
    const ds = await createLLM(cfg, null, { env: stubEnv(dir, "valid", out) }).decide({ profile, resumes, vacancies });
    expect(ds[0]!.resume_fit).toBe("poor");
    expect(ds[0]!.tailored).toEqual({ title: "React-разработчик", about: "Пишу на React и TypeScript. Готов.", key_skills: ["React", "TypeScript"] });
    expect(ds[1]).toMatchObject({ resume_fit: "good" });
    expect(ds[1]!.tailored).toBeUndefined();
    expect(ds[2]).toMatchObject({ resume_fit: "poor" });
    expect(ds[2]!.tailored).toBeUndefined();
  });

  it("decide: batches vacancies in chunks of 5 (two batches in flight), results in order", async () => {
    const dir = stubDir();
    const many = Array.from({ length: 23 }, (_, i) => vacancy(i + 1));
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "valid", []) });
    const ds = await llm.decide({ profile, resumes, vacancies: many });
    expect(count(dir)).toBe(5);
    expect(ds).toHaveLength(23);
    expect(ds.every((d) => !d.apply && d.reason === "no decision")).toBe(true);
    expect(ds.map((d) => d.vacancy_id)).toEqual(many.map((v) => v.id));
    const last = [1, 2, 3, 4, 5].map((n) => readFileSync(`${dir}/prompt-${n}.txt`, "utf8")).find((p) => p.includes("[id=23]"))!;
    expect(last).toContain("[id=21]");
    expect(last).not.toContain("[id=20]");
  });

  it("retries once on garbage with the JSON-only nudge and logs both attempts", async () => {
    const dir = stubDir();
    const store = fakeStore();
    const llm = createLLM(cfg, store, { env: stubEnv(dir, "garbage_then_valid", { direction: "go-backend", seniority: "middle", key_skills: ["Go"], one_line: "Go dev" }) });
    const s = await llm.summarizeResume("Резюме: Go-разработчик, 2 года.");
    expect(s.direction).toBe("go-backend");
    expect(count(dir)).toBe(2);
    expect(readFileSync(`${dir}/prompt-2.txt`, "utf8")).toMatch(/Верни ТОЛЬКО JSON по схеме, без текста до и после\.\s*$/);
    expect(store.llmCalls.map((c) => [c.attempt, c.ok])).toEqual([[1, false], [2, true]]);
    expect(store.llmCalls[0]!.error).toMatch(/no JSON/);
  });

  it("fails after the second bad answer (non-decide tasks) and logs the process error", async () => {
    const dir = stubDir();
    const store = fakeStore();
    const llm = createLLM(cfg, store, { env: stubEnv(dir, "prose", { wrong: true }) });
    await expect(llm.answerChat(profile, null, history)).rejects.toThrow(/invalid output after retry/);
    expect(count(dir)).toBe(2);
    const llm2 = createLLM(cfg, store, { env: stubEnv(stubDir(), "exit1") });
    await expect(llm2.summarizeResume("x")).rejects.toThrow(/code 1/);
    expect(store.llmCalls.at(-1)).toMatchObject({ ok: false, task: "summarize_resume" });
    expect(store.llmCalls.at(-1)!.error).toContain("boom");
  });

  it("answerChat: sanitizes reply, keeps it with needs_human, holds it for unknown skills", async () => {
    const dir = stubDir();
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "valid", { reply: "Да — готов к удалёнке. Kubernetes использовал. Пишите t.me/x.", needs_human: false, reason: "факты из профиля" }) });
    const r = await llm.answerChat(profile, vacancies[0]!, history);
    expect(r).toEqual({ reply: "Да - готов к удалёнке.", needs_human: false, reason: "факты из профиля", unknown_skills: [], interview_at: null });
    const llm2 = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "Да, пришлите тестовое.", needs_human: true, reason: "тестовое" }) });
    expect((await llm2.answerChat(profile, null, history)).reply).toBe("Да, пришлите тестовое.");
    const llm3 = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "Да, работал.", needs_human: false, reason: "x", unknown_skills: ["Scala"] }) });
    expect(await llm3.answerChat(profile, null, history)).toMatchObject({ reply: "", unknown_skills: ["Scala"] });
    const llm4 = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "Да, буду.", needs_human: true, reason: "время", interview_at: "2026-09-25T14:00:00+03:00" }) });
    expect((await llm4.answerChat(profile, null, history)).interview_at).toBe("2026-09-25T11:00:00.000Z");
    const llm5 = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "Да.", needs_human: true, reason: "x", interview_at: "завтра" }) });
    expect((await llm5.answerChat(profile, null, history)).interview_at).toBeNull();
  });

  it("interviewPrep: caps lists, strips never-claim claims from stories", async () => {
    const llm = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", {
      questions: ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"],
      stories: [{ skill: "Go", prompt: "Сервис биллинга на Go. Kubernetes настраивал сам." }, { skill: "", prompt: "пусто" }],
      gaps: ["Kafka: в продакшене не использовал, есть Redis"],
      ask_them: ["a", "b", "c", "d"],
    }) });
    const p = await llm.interviewPrep(profile, vacancies[0]!, "Приглашаем на собеседование");
    expect(p.questions).toHaveLength(7);
    expect(p.ask_them).toHaveLength(3);
    expect(p.stories).toEqual([{ skill: "Go", prompt: "Сервис биллинга на Go." }]);
    expect(p.gaps).toHaveLength(1);
  });

  it("answerChat with quick-reply buttons returns exactly one option", async () => {
    const choices = ["Да, было на последнем месте работы", "Был опыт разработки только веба"];
    const llm = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "да, было на последнем месте работы.", needs_human: false, reason: "x" }) });
    expect((await llm.answerChat(profile, null, history, choices)).reply).toBe(choices[0]);
    const off = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "Конечно!", needs_human: false, reason: "x" }) });
    expect(await off.answerChat(profile, null, history, choices)).toMatchObject({ reply: "", needs_human: true });
    const empty = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "", needs_human: true, reason: "оффер" }) });
    expect(await empty.answerChat(profile, null, history, choices)).toMatchObject({ reply: "", needs_human: true, reason: "оффер" });
    const quiet = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "", needs_human: false, reason: "отказ" }) });
    expect(await quiet.answerChat(profile, null, history, choices)).toMatchObject({ reply: "", needs_human: false });
    const yes = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "Да.", needs_human: false, reason: "x" }) });
    expect((await yes.answerChat(profile, null, history, ["Когда удобно", "Да"])).reply).toBe("Да");
    const ambiguous = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "да", needs_human: false, reason: "x" }) });
    expect(await ambiguous.answerChat(profile, null, history, ["Да, удобно", "Да, но позже"])).toMatchObject({ reply: "", needs_human: true });
  });

  it("answerQuestionnaire: validates option ranges, caps text, drops unknown idx", async () => {
    const dir = stubDir();
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "structured", { answers: [
      { idx: 0, option_idx: 0 },
      { idx: 1, option_idxs: [0, 2, 9, 2] },
      { idx: 2, text: "Два года. Kafka тоже знаю. " + "x".repeat(600) },
      { idx: 3, text: "" },
      { idx: 4, text: "" },
      { idx: 42, text: "?" },
    ] }) });
    const as = await llm.answerQuestionnaire(profile, vacancies[0]!, questions);
    expect(as.map((a) => a.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(as[1]!.option_idxs).toEqual([0, 2]);
    expect(as[2]!.text!.length).toBeLessThanOrEqual(500);
    expect(as[2]!.text).not.toContain("Kafka");
    expect(readFileSync(`${dir}/prompt-1.txt`, "utf8")).toContain("test@example.com");
  });

  it("proposePoolVariants: dedups titles, filters to verified skills, caps at max", async () => {
    const dir = stubDir();
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "valid", [
      { title: "Go-разработчик", about: "dup", key_skills: [], based_on_resume_id: "", direction: "go-backend" },
      { title: "React-разработчик", about: "Пишу на React и TypeScript. Kubernetes знаю.", key_skills: ["react", "Kafka", "TypeScript"], based_on_resume_id: "nope", direction: "react" },
      { title: "react-разработчик", about: "dup2", key_skills: [], based_on_resume_id: "", direction: "react" },
      { title: "Kafka", about: "x", key_skills: [], based_on_resume_id: "", direction: "python" },
      { title: "Python-разработчик", about: "x", key_skills: [], based_on_resume_id: "", direction: "python" },
      { title: "Ещё один", about: "x", key_skills: [], based_on_resume_id: "", direction: "fullstack" },
    ]) });
    const vs = await llm.proposePoolVariants(profile, resumes, 2);
    expect(vs).toHaveLength(2);
    expect(vs[0]).toEqual({ title: "React-разработчик", about: "Пишу на React и TypeScript.", key_skills: ["React", "TypeScript"], based_on_resume_id: "aaa111", direction: "react" });
    expect(vs[1]!.direction).toBe("go-backend");
  });

  it("tailorCV: keeps jobs/education/contacts, drops unverified tools, caps bullets", async () => {
    const dir = stubDir();
    const tailored = {
      ...cv,
      title: "Go-разработчик",
      name: "Кто-то другой",
      about: "Go-разработчик — платежи. Kubernetes в проде.",
      skills: [{ name: "Языки", items: ["Go", "Rust", "TypeScript"] }],
      jobs: [
        { ...cv.jobs[1]!, bullets: ["Писал REST API на Node.js/TypeScript", "Интегрировал сервис со Scala-бэкендом."] },
        { ...cv.jobs[0]!, company: "финтех ооо", period: "2019 - 2030", bullets: ["Вынес кэш в Redis. " + "д".repeat(300), "Настроил CI/CD", "Деплоил в Kubernetes"], stack: ["Go", "Kafka"] },
      ],
      education: [],
    };
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "valid", { cv: tailored, changes: ["title под вакансию — Go"] }) });
    const r = await llm.tailorCV(profile, cv, vacancies[0]!, "tailor");
    expect(r.cv.name).toBe(cv.name);
    expect(r.cv.contacts).toEqual(cv.contacts);
    expect(r.cv.education).toEqual(cv.education);
    expect(r.cv.jobs.map((j) => [j.company, j.period])).toEqual(cv.jobs.map((j) => [j.company, j.period]));
    expect(r.cv.jobs[0]!.bullets).toEqual(["Вынес кэш в Redis.", "Настроил CI/CD"]);
    expect(r.cv.jobs[0]!.stack).toEqual(["Go"]);
    expect(r.cv.jobs[1]!.bullets).toEqual(["Писал REST API на Node.js/TypeScript"]);
    expect(r.cv.skills).toEqual([{ name: "Языки", items: ["Go", "TypeScript"] }]);
    expect(r.cv.about).toBe("Go-разработчик - платежи.");
    expect(r.changes[0]).toBe("title под вакансию - Go");
    expect(r.changes.at(-1)).toMatch(/guard: .*Rust.*Kafka/);
    expect(readFileSync(`${dir}/argv.log`, "utf8")).toContain("--model opus");
  });

  it("coverLetterCareer and json()", async () => {
    const dir = stubDir();
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "valid", { cover_letter: "Здравствуйте. Откликаюсь на Go. Портфолио www.me.ru. Готов обсудить детали." }) });
    expect(await llm.coverLetterCareer(profile, cv, vacancies[0]!)).toBe("Здравствуйте. Откликаюсь на Go. Готов обсудить детали.");
    expect(readFileSync(`${dir}/prompt-1.txt`, "utf8")).not.toContain(cv.contacts.email);
    const llm2 = createLLM(cfg, null, { env: stubEnv(dir, "prose", { ats: "lever" }) });
    const j = await llm2.json<{ ats: string }>("site_onboard", "write", "Страница: ...", '{ "ats": string }');
    expect(j.ats).toBe("lever");
    expect(readFileSync(`${dir}/prompt-2.txt`, "utf8")).toMatch(/## Схема ответа\n\n\{ "ats": string \}\n\nВерни только JSON\.\n$/);
    expect(readFileSync(`${dir}/argv.log`, "utf8").split("\n")[1]).toContain("--model sonnet");
  });

  it("withRun tags calls without touching the original", async () => {
    const dir = stubDir();
    const store = fakeStore();
    const base = createLLM(cfg, store, { env: stubEnv(dir, "valid", { direction: "x", seniority: "", key_skills: [], one_line: "" }) });
    await base.withRun(3).summarizeResume("a");
    await base.summarizeResume("b");
    expect(store.llmCalls.map((c) => c.runId)).toEqual([3, null]);
  });
});

describe("FakeLLM", () => {
  it("returns canned answers, records calls, supports overrides and withRun", async () => {
    const f = new FakeLLM();
    const ds = await f.decide({ profile, resumes, vacancies });
    expect(ds).toHaveLength(3);
    expect(ds[0]!.resume_id).toBe("aaa111");
    f.onAnswerChat = () => ({ reply: "", needs_human: true, reason: "test" });
    const tagged = f.withRun(9);
    expect((await tagged.answerChat(profile, null, [])).needs_human).toBe(true);
    expect(f.calls.map((c) => [c.method, c.runId])).toEqual([["decide", null], ["answerChat", 9]]);
    expect((await f.stagehand().generate({ messages: [{ role: "user", content: "hi" }] })).text).toContain("hi");
    expect((await f.tailorCV(profile, cv, vacancies[0]!)).cv.title).toBe(vacancies[0]!.title);
  });
});
