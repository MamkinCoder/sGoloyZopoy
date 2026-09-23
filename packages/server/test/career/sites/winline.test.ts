import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as winline } from "../../../src/career/ats/sites/winline.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("winline ats client", () => {
  it("detects the Winline careers host", () => {
    expect(winline.detect("https://rabota.winline.ru/vacancies", "")).toEqual({ token: "https://rabota.winline.ru" });
    expect(winline.detect("https://winline.ru/career", "")).toBeNull();
    expect(winline.detect("https://example.com/", "")).toBeNull();
  });

  it("detects by embedded API URL when the host differs", () => {
    expect(winline.detect("https://example.com/", 'data-url="/zen/hrhub/api/lists.Vacancy:addRecords"')).toBeNull();
    expect(
      winline.detect("https://example.com/", 'url:"https://rabota.winline.ru/zen/hrhub/api/lists.Vacancy:addRecords"'),
    ).toEqual({ token: "https://rabota.winline.ru" });
  });

  it("lists jobs for one category and stops at last_record", async () => {
    const catJson = fixture("winline-vacancies-cat4.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        // Only category_id=4 has fixture data; every other category (and any further page) is empty.
        if (url.includes("category_id=4") && url.includes("offset=0")) return jsonResponse(catJson);
        return jsonResponse("[]");
      }),
    );

    const jobs = await winline.listJobs("https://rabota.winline.ru");

    // Real client paginates all 5 categories; only category 4 offset=0 returned data, and it stopped
    // there because the fixture's second item has last_record: true.
    expect(calls.filter((u) => u.includes("category_id=4"))).toEqual([
      "https://rabota.winline.ru/zen/hrhub/api/lists.Vacancy:addRecords?category_id=4&offset=0",
    ]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "site:winline:484",
      url: "https://rabota.winline.ru/vacancy/operator-call-centra-v-ofis-10",
      title: "Оператор call-центра в офис",
      company: "Winline",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:winline:504",
      url: "https://rabota.winline.ru/vacancy/supervaizer-call-centra-almaty",
      title: "Супервайзер call-центра (Алматы)",
      company: "Winline",
    });
  });

  it("fetches a job's full text from the server-rendered detail page, dropping the referral section", async () => {
    const detailHtml = fixture("winline-vacancy-operator-call-centra-v-ofis-10.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(detailHtml);
      }),
    );

    const discovered = {
      externalId: "site:winline:484",
      url: "https://rabota.winline.ru/vacancy/operator-call-centra-v-ofis-10",
      title: "Оператор call-центра в офис",
      company: "Winline",
    };
    const vacancy = await winline.fetchJob("https://rabota.winline.ru", discovered);

    expect(calls).toEqual(["https://rabota.winline.ru/vacancy/operator-call-centra-v-ofis-10"]);
    expect(vacancy.title).toBe("Оператор call-центра в офис");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Winline");
    expect(vacancy.workFormat).toBe("Сменный график, Полная занятость");
    expect(vacancy.descriptionText).toContain("Обязанности:");
    expect(vacancy.descriptionText).toContain("Консультирование клиентов");
    expect(vacancy.descriptionText).toContain("Требования:");
    expect(vacancy.descriptionText).toContain("Условия:");
    expect(vacancy.descriptionText).not.toContain("друзей");
    expect(vacancy.descriptionText).not.toContain("бонус");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
  });
});
