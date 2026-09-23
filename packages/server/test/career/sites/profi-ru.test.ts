import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as profiRu } from "../../../src/career/ats/sites/profi-ru.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/sites/${name}`, import.meta.url)), "utf8");

const listHtml = fixture("profi-ru-vacancies-list.html");
const detailHtml = fixture("profi-ru-vacancy-php__developer.html");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => vi.unstubAllGlobals());

describe("profi-ru ATS client", () => {
  it("detects by host and path", () => {
    expect(profiRu.detect("https://profi.ru/vacancies/list/", "")).toEqual({ token: "https://profi.ru" });
    expect(profiRu.detect("https://profi.ru/vacancies/", "")).toEqual({ token: "https://profi.ru" });
    expect(profiRu.detect("https://profi.ru/", "")).toBeNull();
    expect(profiRu.detect("https://example.com/", "profi.ru/vacancies/php__developer")).toEqual({ token: "https://profi.ru" });
    expect(profiRu.detect("https://example.com/", "")).toBeNull();
  });

  it("lists all jobs from the __NEXT_DATA__ categories blob", async () => {
    const fetchMock = vi.fn(async () => htmlResponse(listHtml));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await profiRu.listJobs("https://profi.ru");

    expect(fetchMock).toHaveBeenCalledWith("https://profi.ru/vacancies/list/", expect.anything());
    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toMatchObject({
      externalId: "site:profi-ru:809",
      url: "https://profi.ru/vacancies/teamlead_bi/",
      title: "Data Engineering Team Lead (BI Platform)",
      company: "Profi.ru",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:profi-ru:810",
      url: "https://profi.ru/vacancies/php__developer/",
      title: "PHP-разработчик в команду биллинга",
    });
  });

  it("fetches a job's full text from the detail page's __NEXT_DATA__ blob", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:profi-ru:810",
      url: "https://profi.ru/vacancies/php__developer/",
      title: "PHP-разработчик в команду биллинга",
      company: "Profi.ru",
    };

    const vacancy = await profiRu.fetchJob("https://profi.ru", discovered);

    expect(vacancy.source).toBe("site:profi-ru");
    expect(vacancy.company).toBe("Profi.ru");
    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.descriptionText).toContain("Ищем PHP-разработчика в команду биллинга");
    expect(vacancy.descriptionText).toContain("PHP 8 + MySQL");
    expect(vacancy.descriptionText).toContain("Опыт коммерческой разработки на PHP от 3 лет");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
