import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as lenta } from "../../../src/career/ats/sites/lenta.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lenta ats client", () => {
  it("detects the career.lenta.com host", () => {
    expect(lenta.detect("https://career.lenta.com/", "")).toEqual({ token: "https://career.lenta.com" });
    expect(lenta.detect("https://career.lenta.com/about", "")).toEqual({ token: "https://career.lenta.com" });
    expect(lenta.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs across every city with open vacancies, dropping hidden ones", async () => {
    const unfiltered = fixture("lenta-search-table-unfiltered.json");
    const city65 = fixture("lenta-search-table-city65.json");
    const city99 = fixture("lenta-search-table-city99.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url.toString());
        const cityId = new URL(url.toString()).searchParams.get("cityId");
        if (cityId === "65") return jsonResponse(city65);
        if (cityId === "99") return jsonResponse(city99);
        return jsonResponse(unfiltered);
      }),
    );

    const jobs = await lenta.listJobs("https://career.lenta.com");

    // one unfiltered call for the city list, then one call per nonzero-count city (Алексин has count 0, skipped)
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("/v1/search/table/?countItemsPerPage=1000");
    expect(calls.some((c) => c.includes("cityId=65"))).toBe(true);
    expect(calls.some((c) => c.includes("cityId=99"))).toBe(true);
    expect(calls.some((c) => c.includes("cityId=1&"))).toBe(false);

    // the hidden vacancy (isHideOnCareer: true) from city99 is dropped
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.externalId).sort()).toEqual(["site:lenta:60001", "site:lenta:60002"]);
    expect(jobs.find((j) => j.externalId === "site:lenta:60001")).toMatchObject({
      url: "https://career.lenta.com/jobapply/60001",
      title: "Backend-разработчик",
      company: "Lenta",
      location: "Москва",
    });
  });

  it("fetches job detail from the cached listJobs payload, no extra request", async () => {
    const city99 = fixture("lenta-search-table-city99.json");
    const fetchMock = vi.fn(async () => jsonResponse(city99));
    vi.stubGlobal("fetch", fetchMock);

    const [job] = (await lenta.listJobs("https://career.lenta.com")).filter((j) => j.externalId === "site:lenta:60002");
    fetchMock.mockClear();

    const v = await lenta.fetchJob("https://career.lenta.com", job!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.source).toBe("site:lenta");
    expect(v.company).toBe("Lenta");
    expect(v.title).toBe("Аналитик данных");
    expect(v.descriptionText).toContain("Обязанности");
    expect(v.descriptionText).toContain("Power BI, SQL");
    expect(v.descriptionText).toContain("Удаленная работа");
    expect(v.area).toBe("Санкт-Петербург");
    expect(v.salaryFrom).toBe(90000);
    expect(v.salaryTo).toBe(110000);
    expect(v.currency).toBe("RUB");
    expect(v.url).toBe("https://career.lenta.com/jobapply/60002");
  });

  it("falls back to the vacancy-by-id detail endpoint when raw is missing", async () => {
    const detail = fixture("lenta-vacancy-by-id-60002.json");
    const fetchMock = vi.fn(async (url: string) => {
      expect(url.toString()).toBe("https://lenta-career-api.k8s.axes.pro/api/v1/search/vacancy-by-id/60002");
      return jsonResponse(detail);
    });
    vi.stubGlobal("fetch", fetchMock);

    const v = await lenta.fetchJob("https://career.lenta.com", {
      externalId: "site:lenta:60002",
      url: "https://career.lenta.com/jobapply/60002",
      title: "stale title",
      company: "Lenta",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(v.title).toBe("Аналитик данных");
    expect(v.salaryFrom).toBe(90000);
  });
});
