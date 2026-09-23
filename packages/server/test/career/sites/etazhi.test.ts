import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as etazhi } from "../../../src/career/ats/sites/etazhi.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("etazhi ats client", () => {
  it("detects the Etazhi careers host", () => {
    expect(etazhi.detect("https://www.etagi.com/job/vacancies/", "")).toEqual({ token: "https://www.etagi.com" });
    expect(etazhi.detect("https://msk.etagi.com/job/", "")).toEqual({ token: "https://msk.etagi.com" });
    expect(etazhi.detect("https://example.com/careers", "")).toBeNull();
    expect(etazhi.detect("https://example.com/careers", "fetch('https://www.etagi.com/job/vacancies/')")).toEqual({
      token: "https://www.etagi.com",
    });
  });

  it("lists all open vacancies from the inline page data blob", async () => {
    const listHtml = fixture("etazhi-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await etazhi.listJobs("https://www.etagi.com");

    expect(calls).toEqual(["https://www.etagi.com/job/vacancies/"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:etazhi:29894",
      url: "https://www.etagi.com/job/specialist-po-nedvizhimosti-1-340/",
      title: "Специалист по недвижимости",
      company: "Этажи",
      location: "г. Тюмень, ул. Ленина 38/1, 2 этаж",
    });
    expect(jobs[1]!.externalId).toBe("site:etazhi:35369");
    expect(jobs[2]!.externalId).toBe("site:etazhi:35358");
  });

  it("fetches a job's full text and salary range from the detail page", async () => {
    const detailHtml = fixture("etazhi-vacancy-340.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:etazhi:29894",
      url: "https://www.etagi.com/job/specialist-po-nedvizhimosti-1-340/",
      title: "Специалист по недвижимости",
      company: "Этажи",
      location: "г. Тюмень, ул. Ленина 38/1, 2 этаж",
    };
    const vacancy = await etazhi.fetchJob("https://www.etagi.com", discovered);

    expect(vacancy.source).toBe("site:etazhi");
    expect(vacancy.title).toBe("Специалист по недвижимости");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Этажи");
    expect(vacancy.area).toBe("г. Тюмень, ул. Ленина 38/1, 2 этаж");
    expect(vacancy.workFormat).toBe("в офисе");
    expect(vacancy.salaryFrom).toBe(150000);
    expect(vacancy.salaryTo).toBe(0); // open-ended range (amountRange[1] === null)
    expect(vacancy.currency).toBe("RUB");
    expect(vacancy.descriptionText).toContain("Обязанности");
    expect(vacancy.descriptionText).toContain("Привлечение клиентов");
    expect(vacancy.descriptionText).toContain("Требования");
    expect(vacancy.descriptionText).toContain("Компания предлагает");
  });

  it("handles a vacancy with no wages field (interview-only salary)", async () => {
    const listHtml = fixture("etazhi-vacancies.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(listHtml)),
    );
    const jobs = await etazhi.listJobs("https://www.etagi.com");
    const withoutWages = jobs[2]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(fixture("etazhi-vacancies.html"))),
    );
    // reuse the cached raw data via a synthetic detail page absent (fetchJob still needs a detail
    // fetch; simulate a page without a singleVacancy block, falling back to the cached raw listing item)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse("<html><body>no data blob here</body></html>")),
    );
    const vacancy = await etazhi.fetchJob("https://www.etagi.com", withoutWages);
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
    expect(vacancy.currency).toBe("");
    expect(vacancy.title).toBe("Экономист");
  });
});
