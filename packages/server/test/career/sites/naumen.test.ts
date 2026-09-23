import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as naumen } from "../../../src/career/ats/sites/naumen.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const ORIGIN = "https://www.naumen.ru";

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

describe("naumen ats client", () => {
  it("detects the www.naumen.ru host", () => {
    expect(naumen.detect(`${ORIGIN}/career/vacancies/`, "")).toEqual({ token: ORIGIN });
    expect(naumen.detect("https://example.com/career/vacancies/", "")).toBeNull();
  });

  it("detects by page content when the host differs (e.g. redirected through a shortener)", () => {
    expect(naumen.detect("https://example.com/", "<a href='https://www.naumen.ru/career/vacancies/'>jobs</a>")).toEqual({ token: ORIGIN });
  });

  it("lists all jobs from the unpaginated listing page", async () => {
    mockFetch({ [`${ORIGIN}/career/vacancies/`]: fixture("naumen-vacancies.html") });

    const jobs = await naumen.listJobs(ORIGIN);

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:naumen:menedzher-po-soprovozhdeniyu-klientov_EKB",
      url: `${ORIGIN}/career/vacancies/menedzher-po-soprovozhdeniyu-klientov_EKB/`,
      title: "Менеджер по сопровождению клиентов",
      company: "Naumen",
      location: "Екатеринбург",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:naumen:inzhener-po-ruchnomu-funktsionalnomu-testirovaniyu-v-komandu-produkta-naumen-contact-center",
      title: "Инженер по ручному функциональному тестированию в команду продукта Naumen Contact Center",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:naumen:rukovoditel-otdela-tekhnicheskoy-podderzhki_",
      title: "Руководитель отдела технической поддержки",
    });
  });

  it("fetches a job's full text from the server-rendered detail sections", async () => {
    const url = `${ORIGIN}/career/vacancies/menedzher-po-soprovozhdeniyu-klientov_EKB/`;
    mockFetch({ [url]: fixture("naumen-vacancy-menedzher-po-soprovozhdeniyu-klientov.html") });

    const discovered = {
      externalId: "site:naumen:menedzher-po-soprovozhdeniyu-klientov_EKB",
      url,
      title: "Менеджер по сопровождению клиентов",
      company: "Naumen",
      location: "Екатеринбург",
    };

    const vacancy = await naumen.fetchJob(ORIGIN, discovered);

    expect(vacancy.title).toBe("Менеджер по сопровождению клиентов");
    expect(vacancy.company).toBe("Naumen");
    expect(vacancy.url).toBe(url);
    expect(vacancy.area).toBe("Екатеринбург");
    expect(vacancy.workFormat).toBe("Гибридный, Офис");
    expect(vacancy.descriptionText).toContain("Скорозвон (ООО «Смартьюб»)");
    expect(vacancy.descriptionText).toContain("Задачи");
    expect(vacancy.descriptionText).toContain("объяснять, как использовать сервис");
    expect(vacancy.descriptionText).toContain("Требования");
    expect(vacancy.descriptionText).toContain("телефонных/онлайн продаж");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.descriptionText).not.toContain("&nbsp;");
    expect(vacancy.salaryFrom).toBe(0);
  });
});
