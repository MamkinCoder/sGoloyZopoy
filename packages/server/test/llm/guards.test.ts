import { describe, expect, it } from "vitest";
import { blockedTech, enforceMax, ensureDecisions, normalizeProse, pickResumeId, sanitizeLetter, splitSentences, stripLinkSentences, stripNeverClaimSentences } from "../../src/llm/guards.js";
import { renderTemplate } from "../../src/llm/template.js";
import { guardStudy } from "../../src/llm/index.js";
import { DecisionsSchema, unwrapArray } from "../../src/llm/schemas.js";
import { defaultProfile } from "../../src/config/profile.js";
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
  });

  it("keeps honest «not in production» sentences, still drops claims", () => {
    expect(sanitizeLetter("Kafka в продакшене не использовал, работал с очередями на Go. Готов обсудить детали.", ["Kafka"], 1500))
      .toBe("Kafka в продакшене не использовал, работал с очередями на Go. Готов обсудить детали.");
    expect(sanitizeLetter("Настраивал Kafka в проде. Готов.", ["Kafka"], 1500)).toBe("Готов.");
  });

  it("blockedTech unblocks tokens inside verified skills and k8s/Kubernetes aliases", () => {
    const b = blockedTech({ verified_skills: ["Kubernetes", "AWS S3", "Apache Kafka", "JavaScript"], never_claim_skills: [] });
    expect(sanitizeLetter("Деплоил сервисы в k8s и хранил файлы в AWS S3. Писал в Kafka.", b, 1500)).toBe("Деплоил сервисы в k8s и хранил файлы в AWS S3. Писал в Kafka.");
    expect(b).toContain("Java");
    expect(blockedTech({ verified_skills: ["k8s"], never_claim_skills: [] })).not.toContain("Kubernetes");
    expect(blockedTech({ verified_skills: ["Kubernetes"], never_claim_skills: ["k8s"] })).toContain("k8s");
  });

  it("link guard catches bare hosts, emails and phones, leaves tech names and dates", () => {
    const t = "Код: github.com/nick/repo. Пишите на nick@example.com. Звоните +7 000 000-00-00. Или 8 (000) 000-00-00. Профиль habr.com тоже. Работал с Node.js и Socket.io в 2019 - 2023, вилка 150 000 - 200 000. Готов.";
    expect(stripLinkSentences(t)).toBe("Работал с Node.js и Socket.io в 2019 - 2023, вилка 150 000 - 200 000. Готов.");
  });

  it("X.js/Y stacks and React.memo are not links; host/path with a real TLD and t.me still are", () => {
    expect(sanitizeLetter("Привет! Пишу бэкенд на Node.js/TypeScript уже 5 лет. Готов обсудить детали.", [], 1500)).toBe("Привет! Пишу бэкенд на Node.js/TypeScript уже 5 лет. Готов обсудить детали.");
    expect(stripLinkSentences("Backend-разработчик (Node.js/NestJS)")).toBe("Backend-разработчик (Node.js/NestJS)");
    expect(stripLinkSentences("Фронт на Next.js/React и Vue.js/Nuxt. Использовал React.memo.")).toBe("Фронт на Next.js/React и Vue.js/Nuxt. Использовал React.memo.");
    expect(stripLinkSentences("Код на example.io/me. Пиши в t.me/abc. Ок.")).toBe("Ок.");
  });

  it("honest «no experience, ready to learn» answers survive; claims and «не было проблем» do not", () => {
    const never = ["Kafka"];
    for (const s of ["С Kafka не работал, но готов быстро освоить.", "Коммерческого опыта с Kafka нет, есть опыт с Redis Streams.", "Нет коммерческого опыта с Kafka.", "Kafka в проде не было."])
      expect(stripNeverClaimSentences(s, never)).toBe(s);
    for (const s of ["С Kafka не было проблем.", "Опыта с Kafka много, проблем нет.", "Работал с Kafka в продукте."]) expect(stripNeverClaimSentences(s, never)).toBe("");
  });

  it("sanitizeLetter keeps paragraphs and « .NET»", () => {
    expect(sanitizeLetter("Привет!\n\nПишу на Go 3 года.\n\nГотов обсудить детали.", [], 1500)).toBe("Привет!\n\nПишу на Go 3 года.\n\nГотов обсудить детали.");
    expect(sanitizeLetter("Привет!\n\nРаботал с Kafka.\n\nГотов обсудить детали.", ["Kafka"], 1500)).toBe("Привет!\n\nГотов обсудить детали.");
    expect(sanitizeLetter("Писал на ASP.NET Core и .NET 8. Готов.", [], 1500)).toBe("Писал на ASP.NET Core и .NET 8. Готов.");
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

describe("study checklist and decide output", () => {
  it("guardStudy keeps ASP.NET / Socket.io / Deno.dev topics, drops links", () => {
    const item = (topic: string) => ({ topic, why: "", level: "must" as const, gap: false, study: "" });
    const out = guardStudy({ ...defaultProfile(), never_claim_skills: [] }, [item("ASP.NET: middleware, DI"), item("Socket.io и Deno.dev"), item("Дока на habr.com"), item("См. example.io/docs")]);
    expect(out.map((i) => i.topic)).toEqual(["ASP.NET: middleware, DI", "Socket.io и Deno.dev"]);
  });

  it("a string `apply` and a bare decision object for a one-vacancy batch still parse", () => {
    const d = { vacancy_id: 7, apply: "true", reason: "ok" };
    expect(DecisionsSchema.parse(unwrapArray(d))).toMatchObject([{ vacancy_id: 7, apply: true }]);
    expect(DecisionsSchema.parse([{ ...d, apply: "false" }])[0]!.apply).toBe(false);
    expect(DecisionsSchema.safeParse([{ ...d, apply: "maybe" }]).success).toBe(false);
  });
});

describe("template renderer", () => {
  it("substitutes vars, dotted paths, ifs and partials", () => {
    const out = renderTemplate("{{> p}} {{a}} {{o.b}} {{#if x}}X{{/if}}{{#if y}}Y{{/if}} {{list}}", { a: 1, o: { b: "B" }, x: "", y: [1], list: ["q"] }, () => "P");
    expect(out).toBe('P 1 B Y [\n  "q"\n]');
  });
});

describe("normalizeProse typo fixes", () => {
  it("fixes «влюсь» but leaves other words alone", () => {
    expect(normalizeProse("Легко влюсь в команду. Влюсь быстро.")).toBe("Легко вливаюсь в команду. Вливаюсь быстро.");
    expect(normalizeProse("Я влюбляюсь в код")).toBe("Я влюбляюсь в код");
  });
});
