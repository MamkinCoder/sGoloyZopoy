import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as erTelecom } from "../../../src/career/ats/sites/er-telecom.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("er-telecom ats client", () => {
  it("detects the ER-Telecom careers host", () => {
    expect(erTelecom.detect("https://job.ertelecom.ru/vacancies", "")).toEqual({ token: "https://job.ertelecom.ru" });
    expect(erTelecom.detect("https://ertelecom.ru/career", "")).toBeNull();
    expect(erTelecom.detect("https://hh.ru/employer/44272", "")).toBeNull();
  });

  it("lists all open jobs across pages via the DRF API", async () => {
    const page1 = fixture("er-telecom-vacancies-page1.json");
    const page2 = fixture("er-telecom-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(url.includes("page=2") ? page2 : page1);
      }),
    );

    const jobs = await erTelecom.listJobs("https://job.ertelecom.ru");

    expect(calls).toEqual(["https://job.ertelecom.ru/api/vacancy/list/?page=1", "https://job.ertelecom.ru/api/vacancy/list/?page=2"]);
    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toMatchObject({
      externalId: "site:er-telecom:86411",
      url: "https://job.ertelecom.ru/vacancy/86411",
      title: "Специалист группы сопровождения договоров B2C",
      company: "ER-Telecom",
      location: "Пермь",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:er-telecom:86401", title: "Администратор баз данных / DBA Oracle", location: "Вся Россия" });
    expect(jobs[2]).toMatchObject({ externalId: "site:er-telecom:86371", title: "Fullstack разработчик (Node.js, React.js)", location: "Москва" });
    expect(jobs[3]).toMatchObject({ externalId: "site:er-telecom:86361", title: "Старший инженер по обеспечению качества (QA)" });
  });

  it("stops paginating once next is null", async () => {
    const page1 = fixture("er-telecom-vacancies-page1.json");
    const onlyPage = JSON.parse(page1) as { next: string | null };
    onlyPage.next = null;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(JSON.stringify(onlyPage));
      }),
    );

    await erTelecom.listJobs("https://job.ertelecom.ru");

    expect(calls).toHaveLength(1);
  });

  it("fetches a job's full plain-text description", async () => {
    const detailJson = fixture("er-telecom-vacancy-86371.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(detailJson);
      }),
    );

    const discovered = {
      externalId: "site:er-telecom:86371",
      url: "https://job.ertelecom.ru/vacancy/86371",
      title: "Fullstack разработчик (Node.js, React.js)",
      company: "ER-Telecom",
      location: "Москва",
    };
    const vacancy = await erTelecom.fetchJob("https://job.ertelecom.ru", discovered);

    expect(calls).toEqual(["https://job.ertelecom.ru/api/vacancy/86371/"]);
    expect(vacancy.title).toBe("Fullstack разработчик (Node.js, React.js)");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("ER-Telecom");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.workFormat).toBe("Полный день");
    expect(vacancy.descriptionText).toContain("Проектировать отказоустойчивые масштабируемые микросервисы");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(0);
    expect(vacancy.salaryTo).toBe(0);
  });
});
