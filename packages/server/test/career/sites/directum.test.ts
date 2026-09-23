import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as directum } from "../../../src/career/ats/sites/directum.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const ORIGIN = "https://career.directum.ru";

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

function mockFetch(routes: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = routes[url];
      if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
      return htmlResponse(body);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("directum ats client", () => {
  it("detects the career.directum.ru host", () => {
    expect(directum.detect(`${ORIGIN}/vacancy`, "")).toEqual({ token: ORIGIN });
    expect(directum.detect("https://example.com/vacancy", "")).toBeNull();
  });

  it("detects by page content when the host differs", () => {
    expect(directum.detect("https://example.com/", "<a href='https://career.directum.ru/vacancy'>jobs</a>")).toEqual({ token: ORIGIN });
  });

  it("lists all jobs from every direction on the unpaginated listing page", async () => {
    mockFetch({ [`${ORIGIN}/vacancy`]: fixture("directum-vacancy.html") });

    const jobs = await directum.listJobs(ORIGIN);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:directum:backend_developer_go",
      url: `${ORIGIN}/backend_developer_go`,
      title: "Backend-разработчик (Go)",
      company: "Directum",
      location: "Ижевск",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:directum:qa_engineer",
      title: "Инженер по тестированию",
      location: "Удалённая работа",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:directum:strategy_implementation_consultant",
      title: "Консультант по реализации стратегии (методолог)",
    });
  });

  it("fetches a job's full text from the server-rendered detail page", async () => {
    const url = `${ORIGIN}/backend_developer_go`;
    mockFetch({ [url]: fixture("directum-backend_developer_go.html") });

    const discovered = {
      externalId: "site:directum:backend_developer_go",
      url,
      title: "Backend-разработчик (Go)",
      company: "Directum",
      location: "Ижевск",
    };

    const vacancy = await directum.fetchJob(ORIGIN, discovered);

    expect(vacancy.title).toBe("Backend-разработчик (Go)");
    expect(vacancy.company).toBe("Directum");
    expect(vacancy.url).toBe(url);
    expect(vacancy.area).toBe("Ижевск");
    expect(vacancy.workFormat).toBe("Офис, Полная занятость");
    expect(vacancy.descriptionText).toContain("Мы компания Directum");
    expect(vacancy.descriptionText).toContain("Чем предстоит заниматься");
    expect(vacancy.descriptionText).toContain("разрабатывать бэкенд-сервисы на Go");
    expect(vacancy.descriptionText).toContain("Что нам важно");
    expect(vacancy.descriptionText).toContain("опыт коммерческой разработки на Go");
    expect(vacancy.descriptionText).not.toContain("Почему стоит идти к нам");
    expect(vacancy.descriptionText).not.toContain("Бонусы и система");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.descriptionText).not.toContain("&nbsp;");
    expect(vacancy.salaryFrom).toBe(0);
  });
});
