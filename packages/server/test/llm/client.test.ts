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
    expect(store.llmCalls[0]).toMatchObject({ runId: 7, task: "decide_hh", model: "haiku", ok: true, attempt: 1, error: "" });
    expect(store.llmCalls[0]!.promptChars).toBeGreaterThan(1000);
    const prompt = readFileSync(`${dir}/prompt-1.txt`, "utf8");
    expect(prompt).toContain("Kubernetes, Kafka, RabbitMQ, ClickHouse");
    expect(prompt).toContain("[id=2] Senior Go Developer");
    expect(prompt).not.toContain("test@example.com");
  });

  it("decide: batches >10 vacancies sequentially in chunks of 10", async () => {
    const dir = stubDir();
    const many = Array.from({ length: 23 }, (_, i) => vacancy(i + 1));
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "valid", []) });
    const ds = await llm.decide({ profile, resumes, vacancies: many });
    expect(count(dir)).toBe(3);
    expect(ds).toHaveLength(23);
    expect(ds.every((d) => !d.apply && d.reason === "no decision")).toBe(true);
    expect(readFileSync(`${dir}/prompt-3.txt`, "utf8")).toContain("[id=23]");
    expect(readFileSync(`${dir}/prompt-3.txt`, "utf8")).not.toContain("[id=20]");
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

  it("answerChat: sanitizes reply, needs_human empties it", async () => {
    const dir = stubDir();
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "valid", { reply: "Да — готов к удалёнке. Kubernetes использовал. Пишите t.me/x.", needs_human: false, reason: "факты из профиля" }) });
    const r = await llm.answerChat(profile, vacancies[0]!, history);
    expect(r).toEqual({ reply: "Да - готов к удалёнке.", needs_human: false, reason: "факты из профиля" });
    const llm2 = createLLM(cfg, null, { env: stubEnv(stubDir(), "valid", { reply: "ok", needs_human: true, reason: "собеседование" }) });
    expect((await llm2.answerChat(profile, null, history)).reply).toBe("");
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
        { ...cv.jobs[1]!, bullets: ["Писал REST API на Node.js/TypeScript"] },
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
