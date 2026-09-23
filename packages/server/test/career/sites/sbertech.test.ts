import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as sbertech } from "../../../src/career/ats/sites/sbertech.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/sites/${name}`, import.meta.url)), "utf8");

const page1 = fixture("sbertech-publications-page1.json");
const page2 = fixture("sbertech-publications-page2.json");

afterEach(() => vi.unstubAllGlobals());

describe("sbertech ATS client", () => {
  it("detects by host", () => {
    expect(sbertech.detect("https://sbertech.ru/", "")).toEqual({ token: "sbertech.ru" });
    expect(sbertech.detect("https://sbertech.ru/career", "")).toEqual({ token: "sbertech.ru" });
    expect(sbertech.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs from the shared Sber publications API, filtered to AOSBT, paginating until total is reached", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const skip = new URL(url.toString()).searchParams.get("skip");
      const body = skip === "0" ? page1 : page2;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await sbertech.listJobs("sbertech.ru");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/public/app-candidate-public-api-gateway/api/v1/publications?skip=0&take=100");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("skip=3");

    // page1 has 3 raw items (2 AOSBT + 1 non-AOSBT Sber item that must be filtered out),
    // page2 has 1 more AOSBT item -> 3 AOSBT jobs total.
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.company === "СберТех")).toBe(true);
    expect(jobs.map((j) => j.externalId)).not.toContain("site:sbertech:4568319");
    expect(jobs[0]).toMatchObject({
      externalId: "site:sbertech:4566794",
      url: "https://rabota.sber.ru/search/4566794/",
      title: "Senior frontend-developer (DataTracker)",
      company: "СберТех",
    });
    expect(jobs[1]?.title).toContain("Лидер направления");
    expect(jobs[2]?.title).toContain("Системный аналитик");
  });

  it("fetches job detail from the cached listJobs payload, no extra request", async () => {
    const fetchMock = vi.fn(async () => new Response(page1, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const [job] = await sbertech.listJobs("sbertech.ru");
    fetchMock.mockClear();

    const v = await sbertech.fetchJob("sbertech.ru", job!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.source).toBe("site:sbertech");
    expect(v.company).toBe("СберТех");
    expect(v.title).toBe("Senior frontend-developer (DataTracker)");
    expect(v.descriptionText).toContain("Обязанности");
    expect(v.descriptionText).toContain("TypeScript, React");
    expect(v.area).toBe("г Москва");
    expect(v.workFormat).toBe("Полный день");
    expect(v.salaryFrom).toBe(0);
  });

  it("reports salary and work format when present", async () => {
    const fetchMock = vi.fn(async () => new Response(page1, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await sbertech.listJobs("sbertech.ru");
    const job = jobs.find((j) => j.title.includes("Лидер направления"));
    const v = await sbertech.fetchJob("sbertech.ru", job!);
    expect(v.salaryFrom).toBe(300000);
    expect(v.salaryTo).toBe(450000);
    expect(v.currency).toBe("RUB");
    expect(v.area).toBe("г Санкт-Петербург");
    expect(v.workFormat).toBe("Удаленная работа");
  });
});
