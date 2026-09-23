import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as simbirsoft } from "../../../src/career/ats/sites/simbirsoft.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("simbirsoft ats client", () => {
  it("detects the SimbirSoft careers host", () => {
    expect(simbirsoft.detect("https://www.simbirsoft.com/vacancies/", "")).toEqual({
      token: "https://www.simbirsoft.com",
    });
    expect(simbirsoft.detect("https://example.com/careers", "")).toBeNull();
    expect(
      simbirsoft.detect("https://example.com/careers", "some markup mentioning www.simbirsoft.com/vacancies"),
    ).toEqual({ token: "https://www.simbirsoft.com" });
  });

  it("lists all jobs across pages via the ajax endpoint", async () => {
    const page1 = fixture("simbirsoft-vacancies-page1.html");
    const page2 = fixture("simbirsoft-vacancies-page2.html");
    const calls: { url: string; headers: HeadersInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: init?.headers });
        return htmlResponse(url.includes("page=2") ? page2 : page1);
      }),
    );

    const jobs = await simbirsoft.listJobs("https://www.simbirsoft.com");

    expect(calls.map((c) => c.url)).toEqual([
      "https://www.simbirsoft.com/ajax/vacancy/?page=1",
      "https://www.simbirsoft.com/ajax/vacancy/?page=2",
    ]);
    // the ajax endpoint 404s without this header
    expect(new Headers(calls[0]?.headers).get("x-requested-with")).toBe("XMLHttpRequest");
    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toMatchObject({
      externalId: "site:simbirsoft:golang-developer",
      url: "https://www.simbirsoft.com/vacancies/golang-developer/",
      title: "Golang-разработчик",
      company: "SimbirSoft",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:simbirsoft:qa-automation",
      title: "QA Automation C#",
    });
    expect(jobs[3]).toMatchObject({
      externalId: "site:simbirsoft:sdet-java",
      title: "SDET Java",
    });
  });

  it("fetches a job with no published salary", async () => {
    const detailHtml = fixture("simbirsoft-vacancy-golang-developer.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:simbirsoft:golang-developer",
      url: "https://www.simbirsoft.com/vacancies/golang-developer/",
      title: "Golang-разработчик",
      company: "SimbirSoft",
    };

    const vacancy = await simbirsoft.fetchJob("https://www.simbirsoft.com", discovered);

    expect(vacancy.title).toBe("Golang-разработчик");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("SimbirSoft");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
    expect(vacancy.area).toBe("Можно удаленно");
    expect(vacancy.workFormat).toBe("Полный рабочий день");
    expect(vacancy.descriptionText).toContain("высоконагруженных, распределенных сервисов на Golang");
    expect(vacancy.descriptionText).toContain("Коммерческий опыт разработки на Golang от 5 лет");
    expect(vacancy.descriptionText).not.toContain("<");
  });

  it("fetches a job with a published salary range", async () => {
    const detailHtml = fixture("simbirsoft-vacancy-sdet-java.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:simbirsoft:sdet-java",
      url: "https://www.simbirsoft.com/vacancies/sdet-java/",
      title: "SDET Java",
      company: "SimbirSoft",
    };

    const vacancy = await simbirsoft.fetchJob("https://www.simbirsoft.com", discovered);

    expect(vacancy.salaryFrom).toBe(200000);
    expect(vacancy.salaryTo).toBe(300000);
    expect(vacancy.currency).toBe("RUB");
    expect(vacancy.area).toBe("Ульяновск");
    expect(vacancy.descriptionText).toContain("Разрабатывать автотесты на Java");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
