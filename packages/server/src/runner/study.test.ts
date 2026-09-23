import { describe, expect, it } from "vitest";
import type { Profile, StudyItem, StudyPack } from "@sgz/shared";
import { defaultProfile } from "../config/profile.js";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { FakeLLM } from "../llm/fake.js";
import { guardStudy } from "../llm/index.js";
import { StudyChecklistSchema } from "../llm/schemas.js";
import { startMock } from "./mock.js";
import { STUDY_PROMPT_MAX, buildStudyPrompt, formatChecklist, parseStudyCallback, preChunks, startStudy, studyCommand, studyTap } from "./study.js";

const profile: Profile = {
  ...defaultProfile(),
  email: "seeker@example.com",
  phone: "+7 900 000-00-00",
  telegram: "@seeker_tg",
  experience: "3 года",
  summary: "Go-разработчик, биллинг и интеграции. Пишите seeker@example.com или +7 900 000-00-00, t.me/seeker_tg",
  verified_skills: ["Go", "PostgreSQL", "Docker"],
  never_claim_skills: ["Kafka"],
};
const items: StudyItem[] = [
  { topic: "Go: горутины, каналы, select, context cancellation", why: "Go в требованиях", level: "must", gap: false, study: "написать worker pool с отменой" },
  { topic: "Kafka: consumer groups, offsets", why: "очереди в стеке", level: "likely", gap: true, study: "разобрать at-least-once" },
];
const vacancy = { title: "Go <Backend> Developer", company: "Рога & Копыта", descriptionText: "Пишем биллинг на Go.\nhttps://jobs.example.com/apply\n" + "Требования. ".repeat(2000) };

describe("study pack: copy prompt", () => {
  it("has the title, the checklist with gaps, no contacts or links, and a length cap", () => {
    const p = buildStudyPrompt(vacancy, profile, items);
    expect(p).toContain("Позиция: Go <Backend> Developer в Рога & Копыта.");
    expect(p).toContain("1. [Обязательно] Go: горутины");
    expect(p).toContain("2. [Скорее всего] Kafka: consumer groups, offsets (пробел - нужно подтянуть)");
    expect(p).toContain("В продакшене не использовал: Kafka.");
    expect(p).toContain("Отвечай по-русски.");
    for (const bad of ["seeker@example.com", "900 000", "seeker_tg", "t.me", "https://"]) expect(p).not.toContain(bad);
    expect(p.length).toBeLessThanOrEqual(STUDY_PROMPT_MAX);
    const huge = buildStudyPrompt(vacancy, { ...profile, summary: "Опыт. ".repeat(5000) }, Array.from({ length: 20 }, (_, i) => ({ ...items[0]!, topic: `Тема ${i} `.repeat(15) })));
    expect(huge.length).toBeLessThanOrEqual(STUDY_PROMPT_MAX);
    expect(huge).toContain("Отвечай по-русски.");
  });
});

describe("study pack: checklist schema + guard", () => {
  it("gives the tutor the vacancy as plain text, not hh's HTML", () => {
    const p = buildStudyPrompt({ ...vacancy, descriptionText: "<p><strong>Задачи:</strong></p><ul><li>Go-сервисы</li><li>Vue.js</li></ul>" }, profile, items);
    expect(p).toContain("Задачи:\n- Go-сервисы\n- Vue.js");
    expect(p).not.toMatch(/<\/?(p|li|ul|strong)>/);
  });

  it("parses tolerant fields and guards links, never-claim gaps, order and the cap", () => {
    const raw = StudyChecklistSchema.parse({
      checklist: [
        { topic: "System design: rate limiter", level: "nice" },
        { topic: "Kafka: партиции", level: "whatever", gap: "да", why: "стек" },
        { topic: "Go: GC", level: "must", gap: false, study: "почитать https://go.dev/doc/gc-guide" },
        { topic: "Статья на habr.com", level: "must" },
        { topic: "Node.js/Express: middleware", level: "likely", gap: true },
        { topic: "go: gc", level: "must" },
      ],
    });
    expect(raw.checklist[1]).toMatchObject({ level: "likely", gap: false, study: "" });
    expect(() => StudyChecklistSchema.parse({ checklist: [{ why: "нет темы" }] })).toThrow();
    const out = guardStudy(profile, raw.checklist);
    expect(out.map((i) => i.topic)).toEqual(["Go: GC", "Kafka: партиции", "Node.js/Express: middleware", "System design: rate limiter"]);
    expect(out[0]!.study).toBe(""); // the link went away
    expect(out[1]!.gap).toBe(true); // never_claim is always a gap
    expect(guardStudy(profile, Array.from({ length: 30 }, (_, i) => ({ ...items[0]!, topic: `t${i}` })))).toHaveLength(20);
  });
});

describe("study pack: telegram", () => {
  it("parses callbacks", () => {
    expect(parseStudyCallback("st:12")).toEqual({ threadId: 12, regen: false });
    expect(parseStudyCallback("st:12:r")).toEqual({ threadId: 12, regen: true });
    expect(parseStudyCallback("st:x")).toBeNull();
    expect(parseStudyCallback("q:s:12")).toBeNull();
  });

  it("formats the checklist by level with escaped text and 📌 on gaps", () => {
    const pack: StudyPack = { checklist: [...items, { ...items[0]!, topic: "a<b>&c", level: "nice", gap: false }], prompt: "", at: "", vacancyTitle: "Go <dev>", company: "A&B" };
    const html = formatChecklist(pack);
    expect(html).toContain("Go &lt;dev&gt; · A&amp;B");
    expect(html.indexOf("<b>Обязательно</b>")).toBeLessThan(html.indexOf("<b>Скорее всего</b>"));
    expect(html).toContain("• 📌 <b>Kafka: consumer groups, offsets</b> - разобрать at-least-once");
    expect(html).toContain("<b>a&lt;b&gt;&amp;c</b>");
  });

  it("splits the prompt into escaped <pre> chunks under 4096, never inside an entity", () => {
    const text = `${"<&>".repeat(3000)}\nстрока\n${"x".repeat(5000)}`;
    const chunks = preChunks(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(c).toMatch(/^<pre>[\s\S]*<\/pre>$/);
      expect(c.slice(5, -6)).not.toMatch(/&(?!amp;|lt;|gt;|quot;)|[<>]/);
    }
    const back = chunks.map((c) => c.slice(5, -6).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).join("");
    expect(back.replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
    expect(preChunks("короткий")).toEqual(["<pre>короткий</pre>"]);
  });
});

describe("study pack: build, resend, /study, /mock", () => {
  function setup() {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    const u = store.listUsers(true)[0]!;
    store.saveProfile(u.id, profile);
    const v = store.upsertVacancy({ source: "hh", externalId: "1", url: "https://hh.ru/vacancy/1", title: "Go dev", company: "Рога", salaryFrom: 0, salaryTo: 0, currency: "", descriptionText: "Go, PostgreSQL", hasTest: false, requiresLetter: false, area: "", workFormat: "", publishedAt: null, archived: false, dedupHash: "" });
    const t = store.upsertChatThread({ userId: u.id, hhNegotiationId: "n1", isBot: false, vacancyId: v.id, employer: "Рога", state: "invited", lastSeenAt: "2026-09-22T10:00:00Z" });
    const llm = new FakeLLM();
    llm.onInterviewStudy = () => items;
    const sent: { text: string; data: string[] }[] = [];
    const notifier = { report: async () => undefined, alert: async () => undefined, ask: async (text: string, b: { data: string }[]) => void sent.push({ text, data: b.map((x) => x.data) }) };
    return { store, llm, notifier, sent, t, d: { store, llm, notifier } };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("builds once, stores it, sends checklist + prompt; a fresh pack is resent without the LLM", async () => {
    const { store, llm, sent, t, d } = setup();
    expect(studyTap(d, { threadId: t.id, regen: false })).toBe("готовлю чеклист…");
    await startStudy(store, llm, t.id);
    await settle();
    expect(llm.calls.filter((c) => c.method === "interviewStudy")).toHaveLength(1);
    expect(store.listChatThreads(t.userId)[0]!.study?.checklist).toHaveLength(2);
    expect(sent[0]!.data).toEqual([`st:${t.id}:r`]);
    expect(sent.at(-1)!.text).toMatch(/^<pre>Ты - мой наставник/);
    expect(studyTap(d, { threadId: t.id, regen: false })).toContain("уже есть");
    await settle();
    expect(llm.calls.filter((c) => c.method === "interviewStudy")).toHaveLength(1);
    expect(studyTap(d, { threadId: t.id, regen: true })).toBe("готовлю чеклист…");
    await settle();
    expect(llm.calls.filter((c) => c.method === "interviewStudy")).toHaveLength(2);
  });

  it("/study picks the invited thread by company; /mock asks about gaps first", async () => {
    const { store, llm, t, d } = setup();
    expect(studyCommand(d, "42", "нет такой")).toContain("Нет приглашения");
    expect(studyCommand(d, "42", "рога")).toBe("Рога: готовлю чеклист…");
    await startStudy(store, llm, t.id);
    expect(startMock(store, "42", "", new Date())).toContain("Вопрос 1: Расскажите, что знаете про тему «Kafka: consumer groups, offsets»");
  });
});
