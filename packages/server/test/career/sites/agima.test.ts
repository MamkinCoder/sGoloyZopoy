import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as agima } from "../../../src/career/ats/sites/agima.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agima ats client", () => {
  it("detects the AGIMA careers host", () => {
    expect(agima.detect("https://www.agima.ru/careers/", "")).toEqual({ token: "https://www.agima.ru" });
    expect(agima.detect("https://example.com/careers", "")).toBeNull();
    expect(agima.detect("https://example.com/careers", "see https://www.agima.ru/careers/ for jobs")).toEqual({
      token: "https://www.agima.ru",
    });
  });

  it("lists all jobs from the server-rendered careers page", async () => {
    const listHtml = fixture("agima-careers.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await agima.listJobs("https://www.agima.ru");

    expect(calls).toEqual(["https://www.agima.ru/careers/"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:agima:art-direktor",
      url: "https://www.agima.ru/careers/vacancy/art-direktor/",
      title: "Арт-директор / Art Director",
      company: "AGIMA",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:agima:systems_administrator",
      url: "https://www.agima.ru/careers/vacancy/systems_administrator/",
      title: "Системный администратор",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:agima:middle_ai-arkhitektor",
      title: "Middle+ AI-архитектор",
    });
  });

  it("fetches a job's full text from the detail page", async () => {
    const detailHtml = fixture("agima-vacancy-systems_administrator.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:agima:systems_administrator",
      url: "https://www.agima.ru/careers/vacancy/systems_administrator/",
      title: "Системный администратор",
      company: "AGIMA",
    };
    const vacancy = await agima.fetchJob("https://www.agima.ru", discovered);

    expect(vacancy.title).toBe("Системный администратор");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("AGIMA");
    expect(vacancy.descriptionText).toContain("настраивать технику и администрировать доступы");
    expect(vacancy.descriptionText).toContain("Что нам важно");
    expect(vacancy.descriptionText).toContain("Что предлагаем");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
  });
});
