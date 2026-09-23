import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as cloudRu } from "../../../src/career/ats/sites/cloud-ru.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloud-ru ats client", () => {
  it("detects the Cloud.ru careers path", () => {
    expect(cloudRu.detect("https://cloud.ru/career/vacancies", "")).toEqual({ token: "https://cloud.ru" });
    expect(cloudRu.detect("https://cloud.ru/career", "")).toEqual({ token: "https://cloud.ru" });
    expect(cloudRu.detect("https://cloud.ru/", "")).toBeNull();
    expect(cloudRu.detect("https://example.com/careers", "some markup mentioning cloud.ru/career/vacancies")).toEqual({
      token: "https://cloud.ru",
    });
  });

  it("lists jobs from the embedded RSC vacanciesData payload", async () => {
    const listHtml = fixture("cloud-ru-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await cloudRu.listJobs("https://cloud.ru");

    expect(calls).toEqual(["https://cloud.ru/career/vacancies"]);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.externalId).sort()).toEqual([
      "site:cloud-ru:2829875",
      "site:cloud-ru:2830355",
      "site:cloud-ru:4188602",
    ]);
    const frontend = jobs.find((j) => j.externalId === "site:cloud-ru:2829875");
    expect(frontend).toMatchObject({
      url: "https://cloud.ru/career/vacancies/2829875",
      title: "Frontend разработчик",
      company: "Cloud.ru",
      location: "Удаленно",
    });
    // unit.name is blank in the raw item; resolved via filters[code=unit].items lookup
    const devops = jobs.find((j) => j.externalId === "site:cloud-ru:4188602");
    expect(devops?.title).toBe("DevOps (Кибербезопасность)");
  });

  it("fetches a job's full text from the server-rendered detail sections", async () => {
    const url = "https://cloud.ru/career/vacancies/2829875";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(fixture("cloud-ru-vacancy-2829875.html"))),
    );

    const v = await cloudRu.fetchJob("https://cloud.ru", {
      externalId: "site:cloud-ru:2829875",
      url,
      title: "Frontend разработчик",
      company: "Cloud.ru",
    });

    expect(v.title).toBe("Frontend разработчик");
    expect(v.company).toBe("Cloud.ru");
    expect(v.url).toBe(url);
    expect(v.workFormat).toBe("Удаленно");
    expect(v.descriptionText).toContain("ОБЯЗАННОСТИ");
    expect(v.descriptionText).toContain("Разрабатывать новый функционал");
    expect(v.descriptionText).toContain("ТРЕБОВАНИЯ");
    expect(v.descriptionText).toContain("УСЛОВИЯ");
    expect(v.descriptionText).not.toContain("<");
    expect(v.salaryFrom).toBe(0);
    expect(v.area).toBe("");
  });

  it("falls back to the discovered title/location when a detail page is missing tags", async () => {
    const url = "https://cloud.ru/career/vacancies/4188602";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(fixture("cloud-ru-vacancy-4188602.html"))),
    );

    const v = await cloudRu.fetchJob("https://cloud.ru", {
      externalId: "site:cloud-ru:4188602",
      url,
      title: "DevOps (Кибербезопасность)",
      company: "Cloud.ru",
      location: "Удаленно",
    });

    expect(v.workFormat).toBe("Удаленно");
    expect(v.descriptionText).toContain("Kubernetes-кластера");
  });
});
