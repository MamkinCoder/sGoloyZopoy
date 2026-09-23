import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as kaspersky } from "../../../src/career/ats/sites/kaspersky.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("kaspersky ats client", () => {
  it("detects the Kaspersky careers host", () => {
    expect(kaspersky.detect("https://careers.kaspersky.ru/vacancies", "")).toEqual({ token: "https://careers.kaspersky.ru" });
    expect(kaspersky.detect("https://example.com/careers", "")).toBeNull();
    expect(kaspersky.detect("https://careers.kaspersky.com/vacancies", "")).toBeNull();
  });

  it("lists all jobs from the embedded flight payload", async () => {
    const listHtml = fixture("kaspersky-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await kaspersky.listJobs("https://careers.kaspersky.ru");

    expect(calls).toEqual(["https://careers.kaspersky.ru/vacancies?pageSize=250"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:kaspersky:25341",
      url: "https://careers.kaspersky.ru/vacancy/25341",
      title: "Project Manager (Security Services)",
      company: "Kaspersky",
      location: "Москва",
    });
    // non-numeric (ObjectId-style) jobReqId formats are handled the same way
    expect(jobs[1]).toMatchObject({
      externalId: "site:kaspersky:668bbf4ab63848f9dd858476",
      url: "https://careers.kaspersky.ru/vacancy/668bbf4ab63848f9dd858476",
      title: "Security Researcher (GReAT)",
    });
    expect(jobs[2]).toMatchObject({ externalId: "site:kaspersky:25826", title: "Developer C++ (KSMG)" });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const detailHtml = fixture("kaspersky-vacancy-25341.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:kaspersky:25341",
      url: "https://careers.kaspersky.ru/vacancy/25341",
      title: "Project Manager (Security Services)",
      company: "Kaspersky",
      location: "Москва",
      raw: { jobReqId: "25341", titles: [{ title: "Project Manager (Security Services)", locale: "en_GB" }], cities: [{ code: "25373", name: "Москва" }] },
    };

    const vacancy = await kaspersky.fetchJob("https://careers.kaspersky.ru", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Kaspersky");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("Сопровождение ключевых клиентов департамента");
    expect(vacancy.descriptionText).toContain("Что Вам необходимо для этого");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
