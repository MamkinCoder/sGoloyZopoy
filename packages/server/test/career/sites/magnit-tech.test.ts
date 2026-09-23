import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as magnitTech } from "../../../src/career/ats/sites/magnit-tech.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("magnit-tech ats client", () => {
  it("detects the magnit.tech host", () => {
    expect(magnitTech.detect("https://magnit.tech/", "")).toEqual({ token: "https://magnit.tech" });
    expect(magnitTech.detect("https://magnit.tech/vacancies/2886", "")).toEqual({ token: "https://magnit.tech" });
    expect(magnitTech.detect("https://example.com/career", "")).toBeNull();
  });

  it("lists jobs from the single-page vacancy API", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(fixture("magnit-tech-vacancies.json"));
      }),
    );

    const jobs = await magnitTech.listJobs("https://magnit.tech");

    expect(calls).toEqual(["https://magnit.tech/api/v1/vacancy?per_page=100"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:magnit-tech:2886",
      url: "https://magnit.tech/vacancies/2886",
      title: "Разработчик Fullstack Senior (Python, Vue.js)",
      company: "Magnit Tech",
      location: "Россия",
    });
    expect(jobs[1]?.location).toBeUndefined(); // location: null in fixture
    expect(jobs[2]).toMatchObject({ externalId: "site:magnit-tech:2921", title: "Главный Kotlin разработчик" });
  });

  it("fetches a job's full text from the detail API", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(fixture("magnit-tech-vacancy-2886.json"));
      }),
    );

    const discovered = {
      externalId: "site:magnit-tech:2886",
      url: "https://magnit.tech/vacancies/2886",
      title: "Разработчик Fullstack Senior (Python, Vue.js)",
      company: "Magnit Tech",
      location: "Россия",
    };
    const vacancy = await magnitTech.fetchJob("https://magnit.tech", discovered);

    expect(calls).toEqual(["https://magnit.tech/api/v1/vacancy/2886"]);
    expect(vacancy.title).toBe("Разработчик Fullstack Senior (Python, Vue.js)");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Magnit Tech");
    expect(vacancy.area).toBe("Россия");
    expect(vacancy.workFormat).toBe("Москва и Краснодар (гибрид/офис), другие города - удаленно");
    expect(vacancy.descriptionText).toContain("Наша команда в поиске Fullstack-разработчика");
    expect(vacancy.descriptionText).toContain("Задачи:");
    expect(vacancy.descriptionText).toContain("Требования:");
    expect(vacancy.descriptionText).toContain("Условия:");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
  });
});
