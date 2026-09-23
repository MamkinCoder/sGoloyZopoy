import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wb } from "../../src/career/ats/wb.js";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

function mockFetchOnce(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("wb ATS client", () => {
  it("detects by host", () => {
    expect(wb.detect("https://career.wb.ru/", "")).toEqual({ token: "career.wb.ru" });
    expect(wb.detect("https://career.rwb.ru/vacancies", "")).toEqual({ token: "career.rwb.ru" });
    expect(wb.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs from the paginated vacancies API", async () => {
    mockFetchOnce(fixture("wb-vacancies.json"));
    const jobs = await wb.listJobs("career.wb.ru");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain("/hr-crm-api/api/v2/pub/vacancies");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "wb:39490",
      url: "https://career.rwb.ru/vacancies/39490",
      title: "Senior QA Automation engineer в WB Chat",
      company: "Wildberries",
    });
    expect(jobs[1]?.location).toBe("Москва");
  });

  it("fetches job detail with structured description", async () => {
    mockFetchOnce(fixture("wb-vacancy-39490.json"));
    const v = await wb.fetchJob("career.wb.ru", {
      externalId: "wb:39490",
      url: "https://career.rwb.ru/vacancies/39490",
      title: "Senior QA Automation engineer в WB Chat",
      company: "Wildberries",
    });
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain("/crm-api/api/v1/pub/vacancies/39490");
    expect(v.company).toBe("Wildberries");
    expect(v.workFormat).toBe("Удаленно");
    expect(v.descriptionText).toContain("Требования");
    expect(v.descriptionText).toContain("Опыт написания автотестов на Golang.");
  });
});
