import { describe, expect, it } from "vitest";
import type { CompanyIntel, LLMClient, LetterOutcome, Profile, ResumeStat, Store, User } from "@sgz/shared";
import { LessonsSchema } from "../llm/schemas.js";
import { renderPrompt } from "../llm/template.js";
import { cleanLessons, decideExtras, lessonSample, lessonsKey, readLessons, refreshLessons } from "./learn.js";

const outcomes = (inv: number, other: number): LetterOutcome[] => [
  ...Array.from({ length: inv }, (_, i) => ({ title: `t${i}`, letter: "Привет!", invited: true })),
  ...Array.from({ length: other }, (_, i) => ({ title: `o${i}`, letter: "Здравствуйте.", invited: false })),
];

function fakeStore(o: { outcomes?: LetterOutcome[]; intel?: Record<string, CompanyIntel>; stats?: ResumeStat[]; settings?: Record<string, string> } = {}) {
  const settings = new Map(Object.entries(o.settings ?? {}));
  const profile = { verified_skills: ["Go"], never_claim_skills: ["Kubernetes"] } as Profile;
  return {
    settings,
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string) => void settings.set(k, v),
    getProfile: () => profile,
    letterOutcomes: () => o.outcomes ?? [],
    companyIntel: () => o.intel ?? {},
    resumeStats: () => o.stats ?? [],
  } as unknown as Store & { settings: Map<string, string> };
}

const user = { id: 1 } as User;
const llm = (lessons: string[]) => {
  const calls: string[] = [];
  return { calls, client: { json: async (_t: string, _tier: string, prompt: string) => (calls.push(prompt), { lessons }) } as unknown as LLMClient };
};

describe("lessons gate", () => {
  it("needs 5 invited and 15 others", () => {
    expect(lessonSample(outcomes(4, 30))).toBeNull();
    expect(lessonSample(outcomes(10, 14))).toBeNull();
    const s = lessonSample(outcomes(12, 20))!;
    expect([s.invited.length, s.other.length]).toEqual([10, 15]);
  });

  it("refreshLessons: skips below the gate and within a week, stores cleaned lessons otherwise", async () => {
    const few = fakeStore({ outcomes: outcomes(2, 2) });
    const a = llm(["x"]);
    expect(await refreshLessons(few, a.client, user)).toBe(false);
    expect(a.calls).toHaveLength(0);

    const store = fakeStore({ outcomes: outcomes(5, 15) });
    const b = llm(["Начинай с роли и стека.", "Упоминай Kubernetes в первой фразе.", "Подробнее тут https://x.ru"]);
    const now = new Date("2026-09-01T00:00:00Z");
    expect(await refreshLessons(store, b.client, user, now)).toBe(true);
    expect(b.calls[0]).toContain("Привели к приглашению (5)");
    expect(readLessons(store, 1)).toEqual({ lessons: ["Начинай с роли и стека."], at: now.toISOString() });
    expect(await refreshLessons(store, b.client, user, new Date("2026-09-05T00:00:00Z"))).toBe(false);
    expect(await refreshLessons(store, b.client, user, new Date("2026-09-09T00:00:00Z"))).toBe(true);
  });

  it("readLessons tolerates garbage", () => {
    expect(readLessons(fakeStore({ settings: { [lessonsKey(1)]: "{oops" } }), 1)).toEqual({ lessons: [], at: "" });
  });

  it("cleanLessons drops unverified tech and caps at 8", () => {
    const p = { verified_skills: ["Go"], never_claim_skills: ["Kubernetes"] };
    expect(cleanLessons(["Пиши про Kubernetes.", ...Array.from({ length: 10 }, (_, i) => `Совет ${i}.`)], p)).toHaveLength(8);
  });

  it("LessonsSchema parses and defaults", () => {
    expect(LessonsSchema.parse({ lessons: ["a"] }).lessons).toEqual(["a"]);
    expect(LessonsSchema.parse({}).lessons).toEqual([]);
    expect(LessonsSchema.safeParse({ lessons: "a" }).success).toBe(false);
  });
});

describe("decide context", () => {
  const intel = (sent: number): CompanyIntel => ({ name: "Ozon", sent, replied: 0, invited: 0, rejected: 0, medianReplyH: null });

  it("min-N gates for company history and resume stats", () => {
    const v = [{ company: "Ozon" }] as never;
    const low = decideExtras(fakeStore({ intel: { ozon: intel(2) }, stats: [{ hhResumeId: "h", title: "Go", sent: 9, resp: 1, inv: 1 }] }), 1, v);
    expect(low).toMatchObject({ companyHistory: {}, resumeStats: [], lessons: [] });
    expect(low.kb?.(v)).toBeUndefined(); // a store without the KB never blocks decide
    const hi = decideExtras(fakeStore({ intel: { ozon: intel(5) }, stats: [{ hhResumeId: "h", title: "Go", sent: 40, resp: 6, inv: 5 }] }), 1, v);
    expect(hi.companyHistory).toEqual({ ozon: "Ozon: 5 откликов, 0 ответов" });
    expect(hi.resumeStats).toEqual(["Резюме Go (id h): 40 откликов, 6 ответов, 5 приглашений"]);
  });

  it("decide_hh omits the advisory blocks when empty", () => {
    const base = { never_claim: "", profile: "{}", resumes: "r", vacancies: "v", count: 1 };
    const empty = renderPrompt("decide_hh", { ...base, company_history: "", resume_stats: "", lessons: "" });
    expect(empty).not.toContain("История откликов");
    expect(empty).not.toContain("Как резюме срабатывали");
    expect(empty).not.toContain("Что срабатывало раньше");
    const full = renderPrompt("decide_hh", { ...base, company_history: "- Ozon: 5 откликов, 0 ответов", resume_stats: "- Резюме Go", lessons: "- Короче." });
    expect(full).toContain("## История откликов в эти компании\n\n- Ozon: 5 откликов, 0 ответов");
    expect(full).toContain("Никогда не отказывай подходящей вакансии");
    expect(full).toContain("- Резюме Go");
    expect(full).toContain("Что срабатывало раньше");
  });
});
