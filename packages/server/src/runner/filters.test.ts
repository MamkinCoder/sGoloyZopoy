import { describe, expect, it, vi } from "vitest";
import { companyKey, Status, type Profile, type Store, type User, type Vacancy } from "@sgz/shared";
import { classify, createRunCompanyTracker, recordSkip, titleScore, type CompanyLimitSettings } from "./filters.js";

describe("companyKey normalization", () => {
  const cases: [string, string][] = [
    ["Ozon", "ozon"],
    ["Ozon Tech", "ozon"],
    ["ООО «Озон Технологии»", "ozon"],
    ["OZON", "ozon"],
    ["Озон", "ozon"],
    ["Avito", "avito"],
    ["Авито", "avito"],
    ["Т-Банк", "tbank"],
    ["T-Bank", "tbank"],
    ["Тинькофф", "tbank"],
    ["VK", "vk"],
    ["ВК", "vk"],
    ["Mail.ru Group", "vk"],
    ["Wildberries", "wildberries"],
    ["Вайлдберриз", "wildberries"],
    ["RWB", "wildberries"],
    ["Сбер", "sber"],
    ["Sber", "sber"],
    ["Сбербанк", "sber"],
    ["Яндекс", "yandex"],
    ["Yandex", "yandex"],
    ["МТС", "mts"],
    ["MTS", "mts"],
    ["Kaspersky", "kaspersky"],
    ["Лаборатория Касперского", "kaspersky"],
  ];
  it.each(cases)("%s -> %s", (input, expected) => {
    expect(companyKey(input)).toBe(expected);
  });

  it("strips legal forms and quotes so different renderings of an unknown company still match", () => {
    const a = companyKey("ООО Рога и Копыта");
    const b = companyKey("АО «Рога и Копыта»");
    const c = companyKey("Рога и Копыта");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

const profile = { exclude_words: [], company_blacklist: [] } as unknown as Profile;
const user = { id: 1 } as User;
const vacancy = (over: Partial<Vacancy> = {}): Vacancy =>
  ({ id: 1, company: "Ozon", title: "Go dev", dedupHash: "h1", ...over }) as Vacancy;

function fakeStore(over: Partial<Store> = {}): Store {
  return {
    hasSentApplication: () => false,
    hasRecentRejection: () => false,
    hasRecentApplicationByDedup: () => false,
    countRecentApplicationsByCompany: () => 0,
    companyLockDirection: () => "",
    ...over,
  } as unknown as Store;
}

const opts = (_store: Store, over: Partial<CompanyLimitSettings> = {}) => ({
  dedupSinceISO: "2000-01-01",
  rejectSinceISO: "2000-01-01",
  company: { maxSent: 10, windowDays: 30, personaLockEnabled: true, ...over },
  companySinceISO: "2000-01-01",
  runTracker: createRunCompanyTracker(),
});

describe("classify: LLM-rejection re-ask skip", () => {
  it("skips a vacancy the LLM already rejected within the window instead of asking again", () => {
    const store = fakeStore({ hasRecentRejection: () => true });
    const o = opts(store);
    const c = classify(store, user, profile, vacancy(), o);
    expect(c).toMatchObject({ kind: "skip", status: Status.SKIP_DEDUP });
  });

  it("otherwise falls through to a normal candidate", () => {
    const store = fakeStore();
    const c = classify(store, user, profile, vacancy(), opts(store));
    expect(c.kind).toBe("candidate");
  });
});

describe("classify: per-company count limit", () => {
  it("skips once the cross-source + in-run count reaches the cap", () => {
    const store = fakeStore({ countRecentApplicationsByCompany: () => 9 });
    const tracker = createRunCompanyTracker();
    tracker.reserve("ozon", "go-backend"); // 1 more sent earlier this same run
    const c = classify(store, user, profile, vacancy(), { ...opts(store), runTracker: tracker });
    expect(c).toMatchObject({ kind: "skip", status: Status.SKIP_COMPANY_LIMIT });
  });

  it("lets it through under the cap", () => {
    const store = fakeStore({ countRecentApplicationsByCompany: () => 8 });
    const tracker = createRunCompanyTracker();
    tracker.reserve("ozon", "go-backend");
    const c = classify(store, user, profile, vacancy(), { ...opts(store), runTracker: tracker });
    expect(c.kind).toBe("candidate");
  });

  it("0 = disabled never skips regardless of count", () => {
    const store = fakeStore({ countRecentApplicationsByCompany: () => 999 });
    const c = classify(store, user, profile, vacancy(), opts(store, { maxSent: 0 }));
    expect(c.kind).toBe("candidate");
  });
});

describe("classify: persona lock surfaced to the caller", () => {
  it("carries the DB-locked direction when persona lock is enabled", () => {
    const store = fakeStore({ companyLockDirection: () => "go-backend" });
    const c = classify(store, user, profile, vacancy(), opts(store));
    expect(c).toMatchObject({ kind: "candidate", lockedDirection: "go-backend" });
  });

  it("in-run lock applies even before the DB has a SENT row for it", () => {
    const store = fakeStore();
    const tracker = createRunCompanyTracker();
    tracker.reserve("ozon", "node-backend");
    const c = classify(store, user, profile, vacancy(), { ...opts(store), runTracker: tracker });
    expect(c).toMatchObject({ kind: "candidate", lockedDirection: "node-backend" });
  });

  it("ignores the lock when persona_lock is disabled", () => {
    const store = fakeStore({ companyLockDirection: () => "go-backend" });
    const c = classify(store, user, profile, vacancy(), opts(store, { personaLockEnabled: false }));
    expect(c).toMatchObject({ kind: "candidate", lockedDirection: "" });
  });
});

describe("RunCompanyTracker", () => {
  it("counts reservations per key and keeps the first recorded direction", () => {
    const t = createRunCompanyTracker();
    expect(t.count("ozon")).toBe(0);
    t.reserve("ozon", "go-backend");
    t.reserve("ozon", "node-backend"); // first direction wins
    expect(t.count("ozon")).toBe(2);
    expect(t.lockedDirection("ozon")).toBe("go-backend");
    expect(t.count("avito")).toBe(0);
  });
});

describe("recordSkip", () => {
  it("does not repeat the same skip for a vacancy seen again", () => {
    const rows: { id: number; status: string; reasonDetail: string }[] = [];
    const touched: number[] = [];
    const store = { lastApplication: () => rows.at(-1) ?? null, insertApplication: (a: never) => rows.push({ ...(a as object), id: rows.length + 1 } as never), touchApplication: (id: number) => touched.push(id) } as unknown as Store;
    const skip = (detail: string) => ({ userId: 1, vacancyId: 2, status: Status.SKIP_FILTER, reasonDetail: detail }) as never;
    recordSkip(store, skip("exclude word: lead"));
    recordSkip(store, skip("exclude word: lead"));
    expect(rows).toHaveLength(1);
    expect(touched).toEqual([1]); // re-seen today: stays on the Filtered page
    recordSkip(store, skip("exclude word: лид"));
    expect(rows).toHaveLength(2);
  });
});

describe("titleScore", () => {
  it("puts the seeker's stack first and unverified stacks last", () => {
    const p = { hh_queries: ["go", "golang", "backend", "python"], verified_skills: ["Go", "Python"], never_claim_skills: [] };
    const titles = ["C#-разработчик, Ozon fresh", "Data Scientist", "Go-разработчик, Платформа", "Backend-разработчик (Golang)"];
    const ranked = [...titles].sort((a, b) => titleScore(b, p) - titleScore(a, p));
    expect(ranked).toEqual(["Backend-разработчик (Golang)", "Go-разработчик, Платформа", "Data Scientist", "C#-разработчик, Ozon fresh"]);
  });
});
