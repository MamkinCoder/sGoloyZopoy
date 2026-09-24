// Phase 4: the knowledge base feeds letters, questionnaires, CVs and prep (kb/context.ts kbBrief/kbForVacancy),
// status-no tags never reach a prompt's KB block and every guard strips them from the output.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Decision, Store } from "@sgz/shared";
import { openStore } from "../../src/db/index.js";
import { seedDefaultUsers } from "../../src/db/users.js";
import { kbBrief, kbForVacancy, withKbNever } from "../../src/kb/context.js";
import { createLLM } from "../../src/llm/index.js";
import { validateCV } from "../../src/resume/validate.js";
import { decideKb } from "../../src/runner/learn.js";
import { cfg, cv, profile, questions, resumes, stubDir, stubEnv, vacancy } from "./fixtures.js";

const GOLDEN = fileURLToPath(new URL("./golden/", import.meta.url));

function kbStore() {
  const store = openStore(":memory:");
  seedDefaultUsers(store);
  const uid = store.getUserBySlug("yaroslav")!.id;
  const tag = (name: string, status: "yes" | "no" | "unknown", aliases: string[] = []) => store.upsertKbTag(uid, { name, status, aliases });
  const redis = tag("Redis", "yes");
  const react = tag("React", "yes");
  const vitest = tag("Vitest", "no", ["витест"]);
  const add = (title: string, company: string, did: string, result: string, tagIds: number[]) =>
    store.saveKbStory({ userId: uid, title, company, period: "2024 - н.в.", context: "", did, result, source: "seed", confirmed: true, hash: "", tagIds });
  add("Кэш сессий", "Финтех", "Вынес кэш сессий в Redis. Покрыл его тестами на Vitest.", "Нагрузка на PostgreSQL упала на 30%.", [redis.id, vitest.id]);
  add("Админка", "Веб-студия", "Делал интерфейсы админки на React.", "", [react.id]);
  add("Тесты на Vitest", "Веб-студия", "Писал тесты.", "", [vitest.id]);
  add("Биллинг", "Финтех", "Рекуррентные подписки через ЮKassa.", "", []);
  return { store, uid };
}

const section = (prompt: string): string => {
  const at = prompt.indexOf("## База знаний");
  if (at < 0) return "";
  const end = prompt.indexOf("\n## ", at + 5);
  return prompt.slice(at, end < 0 ? undefined : end);
};

describe("kbForVacancy / kbBrief", () => {
  it("picks the stories relevant to the vacancy, never shows status-no tags, returns them for the guards", () => {
    const { store, uid } = kbStore();
    const kb = kbForVacancy(store, uid, vacancy(1, { title: "Go-разработчик", descriptionText: "Go, Redis, PostgreSQL. Тесты на Vitest." }))!;
    expect(kb.no).toEqual(["Vitest", "витест"]);
    expect(kb.text).toContain("### Кэш сессий [Redis]");
    expect(kb.text).toContain("Нагрузка на PostgreSQL упала на 30%.");
    expect(kb.text.indexOf("Кэш сессий")).toBeLessThan(kb.text.indexOf("Биллинг") < 0 ? Infinity : kb.text.indexOf("Биллинг"));
    expect(kb.text).toContain("- Redis: есть опыт");
    expect(kb.text).not.toMatch(/vitest|витест/i); // the sentence, the tag link, the topic line and the Vitest-titled story are gone
    expect(kb.text).not.toContain("Админка"); // nothing about React in the vacancy
  });

  it("companies: only stories of the base CV's own companies (tailor_cv)", () => {
    const { store, uid } = kbStore();
    const kb = kbBrief(store, uid, { text: "React и Redis", companies: ["Финтех ООО"] })!;
    expect(kb.text).toContain("Кэш сессий");
    expect(kb.text).not.toContain("Админка");
  });

  it("an empty KB or a broken store gives no block, so nothing blocks an application", () => {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    expect(kbForVacancy(store, store.getUserBySlug("yaroslav")!.id, vacancy(1))).toBeUndefined();
    const broken = { listKbTags: () => { throw new Error("no such table"); }, listKbStories: () => [] } as unknown as Store;
    expect(kbForVacancy(broken, 1, vacancy(1))).toBeUndefined();
  });

  it("withKbNever adds status-no tags to never_claim once, keeps the profile when there are none", () => {
    expect(withKbNever(profile, undefined)).toBe(profile);
    expect(withKbNever(profile, { text: "", no: ["kafka", "Vitest", "vitest"] }).never_claim_skills).toEqual([...profile.never_claim_skills, "Vitest"]);
  });
});

describe("LLM calls with a KB", () => {
  const letter = "Здравствуйте. Вынес кэш сессий в Redis. Покрывал код тестами на Vitest. Готов обсудить детали.";
  const decision = (id: number): Decision => ({ vacancy_id: id, apply: true, reason: "ok", resume_id: "aaa111", cover_letter: letter, direction: "go-backend", seniority: "middle", red_flags: [] });

  it("decide: one KB block per batch, never-claim list carries status-no tags, the letter loses the Vitest sentence", async () => {
    const { store, uid } = kbStore();
    const dir = stubDir();
    const v = vacancy(1, { descriptionText: "Go, Redis. Тесты на Vitest." });
    const ds = await createLLM(cfg, null, { env: stubEnv(dir, "valid", [decision(1)]) }).decide({ profile, resumes, vacancies: [v], kb: decideKb(store, uid) });
    expect(ds[0]!.cover_letter).toBe("Здравствуйте. Вынес кэш сессий в Redis. Готов обсудить детали.");
    const prompt = readFileSync(`${dir}/prompt-1.txt`, "utf8");
    expect(section(prompt)).toContain("Кэш сессий");
    expect(section(prompt)).not.toMatch(/vitest/i);
    expect(prompt).toContain("Kubernetes, Kafka, RabbitMQ, ClickHouse, Vitest, витест");
  });

  it("answerQuestionnaire, coverLetterCareer, interviewPrep, interviewStudy render the block; no KB = no section", async () => {
    const { store, uid } = kbStore();
    const v = vacancy(1);
    const kb = kbForVacancy(store, uid, v, "Расскажите об опыте с Redis");
    const runs: [unknown, (l: ReturnType<typeof createLLM>) => Promise<unknown>][] = [
      [[{ idx: 2, text: "Да, Redis для кэша сессий. Vitest тоже знаю." }], (l) => l.answerQuestionnaire(profile, v, questions, kb)],
      [{ cover_letter: letter }, (l) => l.coverLetterCareer(profile, cv, v, [], kb)],
      [{ questions: [], stories: [], gaps: [], ask_them: [] }, (l) => l.interviewPrep(profile, v, "Ждём на собеседование", kb)],
      [{ checklist: [{ topic: "Vitest: моки", why: "x", level: "must", gap: false, study: "x" }] }, (l) => l.interviewStudy(profile, v, null, kb)],
    ];
    const outs: unknown[] = [];
    for (const [out, run] of runs) {
      const dir = stubDir();
      outs.push(await run(createLLM(cfg, null, { env: stubEnv(dir, "valid", out) })));
      const prompt = readFileSync(`${dir}/prompt-1.txt`, "utf8");
      expect(section(prompt)).toContain("Кэш сессий");
      expect(section(prompt)).not.toMatch(/vitest/i);
    }
    expect(outs[0]).toEqual([{ idx: 2, text: "Да, Redis для кэша сессий." }]);
    expect(outs[1]).toBe("Здравствуйте. Вынес кэш сессий в Redis. Готов обсудить детали.");
    expect(outs[3]).toMatchObject([{ topic: "Vitest: моки", gap: true }]);

    const dir = stubDir();
    await createLLM(cfg, null, { env: stubEnv(dir, "valid", { cover_letter: letter }) }).coverLetterCareer(profile, cv, v);
    expect(readFileSync(`${dir}/prompt-1.txt`, "utf8")).not.toContain("## База знаний");
  });

  it("tailorCV: same-company stories only (golden), base jobs/dates survive, validation still rejects added companies/dates", async () => {
    const { store, uid } = kbStore();
    const kb = kbBrief(store, uid, { text: "Go, Redis", companies: ["Финтех ООО"] });
    const dir = stubDir();
    const tailored = {
      ...cv,
      jobs: [
        { ...cv.jobs[0]!, period: "2020 - н.в.", bullets: ["Вынес кэш сессий в Redis: нагрузка на PostgreSQL упала на 30%.", "Покрыл кэш тестами на Vitest."] },
        cv.jobs[1]!,
        { ...cv.jobs[1]!, company: "Яндекс", period: "2019 - 2020" },
      ],
    };
    const r = await createLLM(cfg, null, { env: stubEnv(dir, "valid", { cv: tailored, changes: [] }) }).tailorCV(profile, cv, vacancy(1), "write", kb);
    const prompt = readFileSync(`${dir}/prompt-1.txt`, "utf8");
    const golden = `${GOLDEN}tailor_cv_kb.txt`;
    if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, prompt);
    expect(prompt).toBe(readFileSync(golden, "utf8"));
    expect(section(prompt)).not.toContain("Админка");

    expect(r.cv.jobs.map((j) => [j.company, j.period])).toEqual(cv.jobs.map((j) => [j.company, j.period]));
    expect(r.cv.jobs[0]!.bullets).toEqual(["Вынес кэш сессий в Redis: нагрузка на PostgreSQL упала на 30%."]);
    expect(validateCV(cv, r.cv, withKbNever(profile, kb).never_claim_skills)).toEqual([]);
    expect(validateCV(cv, tailored, withKbNever(profile, kb).never_claim_skills)).toEqual(
      expect.arrayContaining([expect.stringMatching(/job added or changed: яндекс/), expect.stringMatching(/job added or changed: финтех ооо \| 2020/), expect.stringMatching(/never_claim «Vitest»/)]),
    );
  });
});
