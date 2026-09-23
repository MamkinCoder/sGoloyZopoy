import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as x5Tech } from "../../../src/career/ats/sites/x5-tech.js";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "..", "fixtures", "sites", name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("x5-tech ATS client", () => {
  it("detects by host", () => {
    expect(x5Tech.detect("https://x5.tech/vacancy", "")).toEqual({ token: "https://x5.tech" });
    expect(x5Tech.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs across pages from the public vacancies API", async () => {
    const page1 = fixture("x5-tech-vacancies-page1.json");
    const page2 = fixture("x5-tech-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return url.includes("page=2") ? jsonResponse(page2) : jsonResponse(page1);
      }),
    );

    const jobs = await x5Tech.listJobs("https://x5.tech");

    expect(calls[0]).toContain("prod-lkk-back.x5.ru/api/v2/x5-tech/vacancies/");
    expect(calls[0]).toContain("page=1");
    expect(calls[1]).toContain("page=2");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:x5-tech:5c8fa403-e84d-4b57-85c1-91dc88633224",
      url: "https://x5.tech/vacancy/5c8fa403-e84d-4b57-85c1-91dc88633224",
      title: "Разработчик базы данных Tarantool",
      company: "X5 Tech",
      location: "Москва",
    });
    expect(jobs[2]?.externalId).toBe("site:x5-tech:9a218a72-c924-4f6a-9a7c-1d7f06160453");
  });

  it("fetches job detail with structured description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(String(url)).toContain("/api/v2/x5-tech/vacancies/76dc9436-816f-4583-98a3-c04ac13b32e7/");
        return jsonResponse(fixture("x5-tech-vacancy-76dc9436.json"));
      }),
    );

    const v = await x5Tech.fetchJob("https://x5.tech", {
      externalId: "site:x5-tech:76dc9436-816f-4583-98a3-c04ac13b32e7",
      url: "https://x5.tech/vacancy/76dc9436-816f-4583-98a3-c04ac13b32e7",
      title: "Senior Go developer",
      company: "X5 Tech",
    });

    expect(v.company).toBe("X5 Tech");
    expect(v.title).toBe("Senior Go developer");
    expect(v.area).toBe("Москва");
    expect(v.workFormat).toBe("Офис");
    expect(v.descriptionText).toContain("Требования");
    expect(v.descriptionText).toContain("Опыт коммерческой разработки на Go от 4 лет");
    expect(v.descriptionText).toContain("Условия");
    expect(v.salaryFrom).toBe(0);
  });
});
