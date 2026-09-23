import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as croc } from "../../../src/career/ats/sites/croc.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("croc ats client", () => {
  it("detects the careers.croc.ru host", () => {
    expect(croc.detect("https://careers.croc.ru/vacancies/", "")).toEqual({ token: "https://careers.croc.ru" });
    expect(croc.detect("https://example.com/careers", "")).toBeNull();
    expect(croc.detect("https://career.croc.ru/", "careers.croc.ru/vacancies/")).toEqual({ token: "https://careers.croc.ru" });
  });

  it("lists jobs by discovering section ids then unioning each section's page", async () => {
    const root = fixture("croc-vacancies.html");
    const sec8 = fixture("croc-section-8.html");
    const sec11 = fixture("croc-section-11.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === "https://careers.croc.ru/vacancies/") return htmlResponse(root);
        if (url === "https://careers.croc.ru/vacancies/?sections=8") return htmlResponse(sec8);
        if (url === "https://careers.croc.ru/vacancies/?sections=11") return htmlResponse(sec11);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const jobs = await croc.listJobs("https://careers.croc.ru");

    expect(calls).toEqual([
      "https://careers.croc.ru/vacancies/",
      "https://careers.croc.ru/vacancies/?sections=8",
      "https://careers.croc.ru/vacancies/?sections=11",
    ]);
    const ids = jobs.map((j) => j.externalId).sort();
    expect(ids).toEqual(["site:croc:analitik-ib", "site:croc:devops-inzhener", "site:croc:senior-aqa-python"]);
    expect(jobs.find((j) => j.externalId === "site:croc:senior-aqa-python")).toMatchObject({
      url: "https://careers.croc.ru/vacancies/senior-aqa-python/",
      title: "Senior aQA-инженер Python",
      company: "CROC",
    });
  });

  it("fetches a job's full text, splitting the free-text chips into area/workFormat", async () => {
    const html = fixture("croc-job.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );

    const v = await croc.fetchJob("https://careers.croc.ru", {
      externalId: "site:croc:senior-aqa-python",
      url: "https://careers.croc.ru/vacancies/senior-aqa-python/",
      title: "Senior aQA-инженер Python",
      company: "CROC",
    });

    expect(v.title).toBe("Senior aQA-инженер Python (платформа контейнерной оркестрации)");
    expect(v.company).toBe("CROC");
    expect(v.area).toBe("Москва");
    expect(v.workFormat).toBe("Удаленно по РФ");
    expect(v.descriptionText).toContain("Департамент занимается проектами");
    expect(v.descriptionText).toContain("Ваши задачи:");
    expect(v.descriptionText).toContain("Kubernetes-платформы");
    expect(v.descriptionText).toContain("Наши ожидания:");
    expect(v.descriptionText).not.toContain("&nbsp;");
    expect(v.salaryFrom).toBe(0);
  });

  it("fetches a job with no work-format chip, leaving workFormat blank", async () => {
    const html = fixture("croc-job-no-workformat.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(html)),
    );

    const v = await croc.fetchJob("https://careers.croc.ru", {
      externalId: "site:croc:deloproizvoditel",
      url: "https://careers.croc.ru/vacancies/deloproizvoditel/",
      title: "Делопроизводитель",
      company: "CROC",
    });

    expect(v.title).toBe("Делопроизводитель");
    expect(v.area).toBe("Москва");
    expect(v.workFormat).toBe("");
    expect(v.descriptionText).toContain("административный отдел");
  });
});
