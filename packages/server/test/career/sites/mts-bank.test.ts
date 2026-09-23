import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as mtsBank } from "../../../src/career/ats/sites/mts-bank.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mts-bank ats client", () => {
  it("detects the MTS Bank careers host", () => {
    expect(mtsBank.detect("https://job.mtsbank.ru/vacancies", "")).toEqual({ token: "https://job.mtsbank.ru" });
    expect(mtsBank.detect("https://example.com/careers", "")).toBeNull();
    expect(mtsBank.detect("https://mtsbank.ru/", "")).toBeNull();
  });

  it("lists all live jobs from the Strapi REST API", async () => {
    const listJson = fixture("mts-bank-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson);
      }),
    );

    const jobs = await mtsBank.listJobs("https://job.mtsbank.ru");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("filters[deletedAt][$null]=true");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:mts-bank:1017686",
      url: "https://job.mtsbank.ru/vacancies/1017686",
      title: "Младший бизнес аналитик (Simple One)",
      company: "МТС Банк",
      location: "Москва",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:mts-bank:1016523", title: "Эксперт направления сопровождения пользователей" });
    expect(jobs[2]).toMatchObject({ externalId: "site:mts-bank:1009142", title: "Системный аналитик" });
  });

  it("stops paginating once pageCount is reached", async () => {
    const listJson = fixture("mts-bank-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson); // meta.pagination.pageCount is 1 in the fixture
      }),
    );

    await mtsBank.listJobs("https://job.mtsbank.ru");

    expect(calls).toHaveLength(1);
  });

  it("fetches a job's full text via the cached Strapi id from listJobs", async () => {
    const detailJson = fixture("mts-bank-vacancy-1017686.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:mts-bank:1017686",
      url: "https://job.mtsbank.ru/vacancies/1017686",
      title: "Младший бизнес аналитик (Simple One)",
      company: "МТС Банк",
      location: "Москва",
      raw: { id: 5236, attributes: { externalId: "1017686" } },
    };
    const vacancy = await mtsBank.fetchJob("https://job.mtsbank.ru", discovered);

    expect(calls).toEqual(["https://job.mtsbank.ru/api/career/vacancies/5236?populate=*"]);
    expect(vacancy.title).toBe("Младший бизнес аналитик (Simple One)");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("МТС Банк");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("МТС Банк");
    expect(vacancy.descriptionText).toContain("Обязанности:");
    expect(vacancy.descriptionText).toContain("Собирать и формализовывать потребности");
    expect(vacancy.descriptionText).toContain("Требования:");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
  });

  it("falls back to looking the job up by externalId when no cached raw data is present", async () => {
    const listJson = fixture("mts-bank-vacancies.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(listJson);
      }),
    );

    const discovered = {
      externalId: "site:mts-bank:1017686",
      url: "https://job.mtsbank.ru/vacancies/1017686",
      title: "Младший бизнес аналитик (Simple One)",
      company: "МТС Банк",
    };
    const vacancy = await mtsBank.fetchJob("https://job.mtsbank.ru", discovered);

    expect(calls[0]).toContain("filters[externalId][$eq]=1017686");
    expect(vacancy.title).toBe("Младший бизнес аналитик (Simple One)");
  });
});
