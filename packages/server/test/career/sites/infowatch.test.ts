import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as infowatch } from "../../../src/career/ats/sites/infowatch.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("infowatch ats client", () => {
  it("detects the InfoWatch careers host", () => {
    expect(infowatch.detect("https://www.infowatch.ru/o-kompanii-infowatch/career/vakansii", "")).toEqual({
      token: "https://www.infowatch.ru",
    });
    expect(infowatch.detect("https://example.com/careers", "")).toBeNull();
    expect(infowatch.detect("https://infowatch.ru/careers", "")).toBeNull();
  });

  it("lists all jobs from the server-rendered listing page", async () => {
    const listHtml = fixture("infowatch-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await infowatch.listJobs("https://www.infowatch.ru");

    expect(calls).toEqual(["https://www.infowatch.ru/o-kompanii-infowatch/career/vakansii"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:infowatch:80610",
      url: "https://www.infowatch.ru/o-kompanii-infowatch/career/vakansii/80610",
      title: "Стажер - разработчик Node JS",
      company: "InfoWatch",
      location: "Москва",
    });
    // no city on this one -> location left undefined
    expect(jobs[1]).toMatchObject({
      externalId: "site:infowatch:77664",
      title: "Инженер конфигурационного управления (DevOps)",
      location: undefined,
    });
    expect(jobs[2]).toMatchObject({ externalId: "site:infowatch:80545", title: "Key Account Manager (IFW, NGFW)", location: "Москва" });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const detailHtml = fixture("infowatch-vakansii-80610.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:infowatch:80610",
      url: "https://www.infowatch.ru/o-kompanii-infowatch/career/vakansii/80610",
      title: "Стажер - разработчик Node JS",
      company: "InfoWatch",
      location: "Москва",
    };

    const vacancy = await infowatch.fetchJob("https://www.infowatch.ru", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("InfoWatch");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("Задачи, которые предстоит решать");
    expect(vacancy.descriptionText).toContain("Доработка или рефакторинг функциональности ARMA MС");
    expect(vacancy.descriptionText).not.toContain("<");
  });

  it("fetches a job with no city listed", async () => {
    const detailHtml = fixture("infowatch-vakansii-77664.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:infowatch:77664",
      url: "https://www.infowatch.ru/o-kompanii-infowatch/career/vakansii/77664",
      title: "Инженер конфигурационного управления (DevOps)",
      company: "InfoWatch",
      location: undefined,
    };

    const vacancy = await infowatch.fetchJob("https://www.infowatch.ru", discovered);

    expect(vacancy.area).toBe("");
    expect(vacancy.descriptionText).toContain("Опыт работы с CI/CD");
  });
});
