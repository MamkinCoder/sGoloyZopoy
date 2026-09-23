import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as reksoft } from "../../../src/career/ats/sites/reksoft.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reksoft ats client", () => {
  it("detects the Reksoft careers site by host or by html", () => {
    expect(reksoft.detect("https://career.reksoft.com/vacancies/", "")).toEqual({ token: "https://www.career.reksoft.com" });
    expect(reksoft.detect("https://career.reksoft.com/vacancies/solution-architect/", "")).toEqual({ token: "https://www.career.reksoft.com" });
    expect(reksoft.detect("https://www.reksoft.com/", "")).toBeNull();
    expect(reksoft.detect("https://example.com/", "see career.reksoft.com/vacancies/ for openings")).toEqual({ token: "https://www.career.reksoft.com" });
  });

  it("lists all open jobs from the unpaginated vacancies page", async () => {
    const listHtml = fixture("reksoft-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await reksoft.listJobs("https://career.reksoft.com");

    expect(calls).toEqual(["https://career.reksoft.com/vacancies/"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:reksoft:ai-developer",
      url: "https://career.reksoft.com/vacancies/ai-developer/",
      title: "AI разработчик",
      company: "Reksoft",
      location: undefined,
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:reksoft:lead-acs-tp-engineer",
      title: "Ведущий инженер АСУ ТП",
      location: "Москва",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:reksoft:solution-architect",
      title: "Архитектор решений",
    });
  });

  it("fetches a job's full text from the detail page", async () => {
    const detailHtml = fixture("reksoft-solution-architect.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(detailHtml);
      }),
    );

    const discovered = {
      externalId: "site:reksoft:solution-architect",
      url: "https://career.reksoft.com/vacancies/solution-architect/",
      title: "Архитектор решений",
      company: "Reksoft",
      location: undefined,
      raw: { workFormat: "Гибрид" },
    };
    const vacancy = await reksoft.fetchJob("https://career.reksoft.com", discovered);

    expect(calls).toEqual([discovered.url]);
    expect(vacancy.title).toBe("Архитектор решений");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Reksoft");
    expect(vacancy.workFormat).toBe("Гибрид");
    expect(vacancy.descriptionText).toContain("Приглашаем в команду архитектора решений");
    expect(vacancy.descriptionText).toContain("Проектировании целевой ИТ-архитектуры проекта");
    expect(vacancy.descriptionText).toContain("Опыт работы на позиции Технического архитектора");
    expect(vacancy.descriptionText).not.toContain("<");
  });

  it("stops the description at the requirements list and never leaks the recruiter's contact block (single-row page)", async () => {
    const detailHtml = fixture("reksoft-ai-developer.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:reksoft:ai-developer",
      url: "https://career.reksoft.com/vacancies/ai-developer/",
      title: "AI разработчик",
      company: "Reksoft",
      location: undefined,
      raw: { workFormat: "Гибрид" },
    };
    const vacancy = await reksoft.fetchJob("https://career.reksoft.com", discovered);

    expect(vacancy.descriptionText).toContain("Уверенное владение Java или Python");
    expect(vacancy.descriptionText).not.toContain("Гибридный график работы");
    expect(vacancy.descriptionText).not.toContain("Мария Соловьева");
    expect(vacancy.descriptionText).not.toContain("jobs@example.com");
    expect(vacancy.descriptionText).not.toContain("+70000000000");
  });
});
