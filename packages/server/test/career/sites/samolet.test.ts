import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as samolet } from "../../../src/career/ats/sites/samolet.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/sites/${name}`, import.meta.url)), "utf8");

const page1 = fixture("samolet-vacancies-page1.json");
const page2 = fixture("samolet-vacancies-page2.json");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("samolet ATS client", () => {
  it("detects by host", () => {
    expect(samolet.detect("https://career.samolet.ru/", "")).toEqual({ token: "https://career.samolet.ru" });
    expect(samolet.detect("https://career.samolet.ru/vakansii/", "")).toEqual({ token: "https://career.samolet.ru" });
    expect(samolet.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs from the skillaz vacancies API, paginating until next is null", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const page = new URL(url.toString()).searchParams.get("page");
      return jsonResponse(page === "2" ? page2 : page1);
    });
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await samolet.listJobs("https://career.samolet.ru");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/integrations/skillaz/vacancies/?limit=100&page=1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("page=2");

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:samolet:25844",
      url: "https://career.samolet.ru/vakansii/view/62b8e7f615709aa16886ad1c/",
      title: "Заместитель директора по строительству сетей и головных сооружений",
      company: "Samolet",
      location: "Москва",
    });
    expect(jobs[1]?.title).toBe("Инженер технической поддержки");
    expect(jobs[2]?.location).toBe("Санкт-Петербург");
  });

  it("fetches job detail from the cached listJobs payload, no extra request", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const page = new URL(url.toString()).searchParams.get("page");
      return jsonResponse(page === "2" ? page2 : page1);
    });
    vi.stubGlobal("fetch", fetchMock);

    const [job] = await samolet.listJobs("https://career.samolet.ru");
    fetchMock.mockClear();

    const v = await samolet.fetchJob("https://career.samolet.ru", job!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.source).toBe("site:samolet");
    expect(v.company).toBe("Samolet");
    expect(v.title).toBe("Заместитель директора по строительству сетей и головных сооружений");
    expect(v.area).toBe("Москва");
    expect(v.workFormat).toBe("Объект, 5/2, Полная занятость");
    expect(v.descriptionText).toContain("Специализация: Строительство");
    expect(v.descriptionText).toContain("Опыт: От 1 года до 3 лет");
    expect(v.descriptionText).toContain("Мы партнеры для всех");
    expect(v.descriptionText).not.toContain("<");
    expect(v.salaryFrom).toBe(0);
  });

  it("falls back to a fresh list fetch when raw is missing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(page1));
    vi.stubGlobal("fetch", fetchMock);

    const discovered = {
      externalId: "site:samolet:53404",
      url: "https://career.samolet.ru/vakansii/view/68dbf2cb5e163e6e648bb561/",
      title: "Инженер технической поддержки",
      company: "Samolet",
    };
    const v = await samolet.fetchJob("https://career.samolet.ru", discovered);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(v.title).toBe("Инженер технической поддержки");
    expect(v.area).toBe("Москва");
  });
});
