import { describe, expect, it } from "vitest";
import { Status } from "@sgz/shared";
import { openStore, seedDefaultUsers } from "./index.js";
import { formatBand, SALARY_MIN_N } from "./salary.js";

const vac = (id: number, from: number, to: number, over: { currency?: string; title?: string } = {}) => ({
  source: "hh", externalId: String(id), url: `https://hh.ru/vacancy/${id}`, title: over.title ?? "Go разработчик", company: `C${id}`,
  salaryFrom: from, salaryTo: to, currency: over.currency ?? "RUR", descriptionText: "", hasTest: false, requiresLetter: false,
  area: "Москва", workFormat: "remote", publishedAt: null, archived: false, dedupHash: "",
});

describe("salaryBand", () => {
  it("percentiles over fork midpoints, RUB only, null below the min-N gate", () => {
    const store = openStore(":memory:");
    // 20 postings: midpoints 110k..300k step 10k (forks, single bounds), plus noise that must be ignored
    for (let i = 0; i < 20; i++) {
      const p = 110_000 + i * 10_000;
      store.upsertVacancy(i % 3 === 0 ? vac(i, p, 0) : i % 3 === 1 ? vac(i, 0, p) : vac(i, p - 20_000, p + 20_000));
    }
    store.upsertVacancy(vac(100, 5000, 9000, { currency: "USD" }));
    store.upsertVacancy(vac(101, 0, 0));
    store.upsertVacancy(vac(102, 500, 700)); // hourly rate
    expect(store.salaryBand({})).toEqual({ n: 20, p25: 160_000, p50: 210_000, p75: 250_000 });
    expect(store.salaryBand({ titleLike: "go" })?.n).toBe(20); // case-insensitive, Cyrillic-safe
    expect(store.salaryBand({ titleLike: "РАЗРАБ" })?.n).toBe(20);
    expect(store.salaryBand({ titleLike: "python" })).toBeNull();
  });

  it("per user and CV direction", () => {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    const u = store.listUsers(true)[0]!;
    for (let i = 0; i < SALARY_MIN_N; i++) {
      const v = store.upsertVacancy(vac(i, 200_000, 300_000));
      store.insertApplication({
        userId: u.id, vacancyId: v.id, hhResumeId: null, generatedResumeId: null, runId: 0, status: Status.SKIP_LLM_REJECT,
        reasonDetail: "", coverLetter: "", llmDecision: null, direction: i === 0 ? "" : "go-backend",
      });
    }
    expect(store.salaryBand({ userId: u.id })).toMatchObject({ n: SALARY_MIN_N, p50: 250_000 });
    expect(store.salaryBand({ userId: u.id, direction: "go-backend" })).toBeNull(); // 14 < min-N
    expect(store.salaryBand({ userId: u.id + 99 })).toBeNull();
  });

  it("formats in thousands", () => {
    expect(formatBand({ n: 42, p25: 250_000, p50: 290_000, p75: 350_000 })).toBe("250k-350k, медиана 290k (n=42)");
  });
});
