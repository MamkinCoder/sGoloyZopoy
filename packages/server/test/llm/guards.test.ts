import { describe, expect, it } from "vitest";
import { containsNeverClaim, enforceMax, ensureDecisions, normalizeProse, pickResumeId, sanitizeLetter, splitSentences, stripLinkSentences, stripNeverClaimSentences } from "../../src/llm/guards.js";
import { renderTemplate } from "../../src/llm/template.js";
import { resumes, vacancies } from "./fixtures.js";

describe("guards", () => {
  it("strips sentences containing links, handles, t.me", () => {
    const t = "Здравствуйте. Мой код на https://github.com/x. Пишите в t.me/xyz или @handle_1. Готов обсудить детали.";
    expect(stripLinkSentences(t)).toBe("Здравствуйте. Готов обсудить детали.");
    expect(stripLinkSentences("См. www.site.ru тут! Ок.")).toBe("Ок.");
  });

  it("drops never_claim sentences with cyrillic-aware word boundaries", () => {
    const never = ["Kubernetes", "Kafka"];
    expect(stripNeverClaimSentences("Работал с Go. Разворачивал в Kubernetes кластере. Знаю Redis.", never)).toBe("Работал с Go. Знаю Redis.");
    expect(containsNeverClaim("использую kafka-connect", never)).toBe(true);
    expect(containsNeverClaim("Kafkaesque story", never)).toBe(false);
    expect(containsNeverClaim("ничего", [])).toBe(false);
  });

  it("normalizes prose: em-dash, emoji, bullets", () => {
    expect(normalizeProse("Go — язык 🚀\n- пункт")).toBe("Go - язык\nпункт");
  });

  it("enforces max length at a sentence boundary", () => {
    expect(enforceMax("Первое. Второе предложение. Третье.", 16)).toBe("Первое. Второе предложение.".slice(0, 7));
    expect(enforceMax("abc", 10)).toBe("abc");
    expect(enforceMax("x".repeat(50), 10)).toHaveLength(10);
    expect(splitSentences("A. B! C?")).toEqual(["A.", "B!", "C?"]);
  });

  it("sanitizeLetter combines everything", () => {
    const out = sanitizeLetter("Здравствуйте — я тут. Ссылка https://a.b. Настраивал Kafka. Готов обсудить детали.", ["Kafka"], 1500);
    expect(out).toBe("Здравствуйте - я тут. Готов обсудить детали.");
  });

  it("validates resume ids: exact, by direction, else first", () => {
    expect(pickResumeId("bbb222", "", resumes)).toBe("bbb222");
    expect(pickResumeId("nope", "fullstack", resumes)).toBe("ccc333");
    expect(pickResumeId("nope", "android", resumes)).toBe("aaa111");
    expect(pickResumeId("x", "x", [])).toBe("");
  });

  it("ensures a decision per vacancy and cleans letters", () => {
    const out = ensureDecisions(
      vacancies,
      [
        { vacancy_id: 2, apply: true, reason: "ок", resume_id: "zzz", cover_letter: "Привет. Kafka знаю. Сайт www.x.ru. Готов.", direction: "node-backend", seniority: "middle", red_flags: [] },
        { vacancy_id: 2, apply: false, reason: "dup", resume_id: "", cover_letter: "", direction: "", seniority: "", red_flags: [] },
      ],
      resumes,
      ["Kafka"],
    );
    expect(out.map((d) => d.vacancy_id)).toEqual([1, 2, 3]);
    expect(out[0]).toMatchObject({ apply: false, reason: "no decision" });
    expect(out[1]).toMatchObject({ apply: true, resume_id: "bbb222", cover_letter: "Привет. Готов.", reason: "ок" });
    expect(out[2]!.apply).toBe(false);
  });
});

describe("template renderer", () => {
  it("substitutes vars, dotted paths, ifs and partials", () => {
    const out = renderTemplate("{{> p}} {{a}} {{o.b}} {{#if x}}X{{/if}}{{#if y}}Y{{/if}} {{list}}", { a: 1, o: { b: "B" }, x: "", y: [1], list: ["q"] }, () => "P");
    expect(out).toBe('P 1 B Y [\n  "q"\n]');
  });
});
