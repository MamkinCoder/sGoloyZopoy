import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as mve } from "../../../src/career/ats/sites/mvideoeldorado.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/sites/${name}`, import.meta.url)), "utf8");

const page1 = fixture("mvideoeldorado-vacancies-page1.json");
const page2 = fixture("mvideoeldorado-vacancies-page2.json");
const detail = fixture("mvideoeldorado-vacancy-5e4fc6d6fb49570008a0819f.json");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("mvideoeldorado ATS client", () => {
  it("detects by host", () => {
    expect(mve.detect("https://career.mvideoeldorado.ru/", "")).toEqual({ token: "https://career.mvideoeldorado.ru" });
    expect(mve.detect("https://career.mvideoeldorado.ru/vacancies", "")).toEqual({ token: "https://career.mvideoeldorado.ru" });
    expect(mve.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs across pages, stopping once total_count is reached", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => jsonResponse(String(url).includes("page=2") ? page2 : page1));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await mve.listJobs("https://career.mvideoeldorado.ru");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/vacancies/search?page=1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v1/vacancies/search?page=2");

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:mvideoeldorado:5e4fc6d6fb49570008a0819f",
      url: "https://career.mvideoeldorado.ru/vacancies/5e4fc6d6fb49570008a0819f",
      title: "Продавец",
      company: "М.Видео-Эльдорадо",
      location: "МО, Солнечногорский р-н",
    });
    expect(jobs[2]?.externalId).toBe("site:mvideoeldorado:5e5a98306a012900083076a9");
  });

  it("fetches job detail with structured description", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(detail));
    vi.stubGlobal("fetch", fetchMock);

    const v = await mve.fetchJob("https://career.mvideoeldorado.ru", {
      externalId: "site:mvideoeldorado:5e4fc6d6fb49570008a0819f",
      url: "https://career.mvideoeldorado.ru/vacancies/5e4fc6d6fb49570008a0819f",
      title: "Продавец",
      company: "М.Видео-Эльдорадо",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/vacancy/5e4fc6d6fb49570008a0819f");
    expect(v.company).toBe("М.Видео-Эльдорадо");
    expect(v.workFormat).toBe("В офисе");
    expect(v.salaryTo).toBe(120000);
    expect(v.currency).toBe("RUB");
    expect(v.descriptionText).toContain("Обязанности");
    expect(v.descriptionText).toContain("Продавать качественную технику");
    expect(v.descriptionText).toContain("Требования");
    expect(v.descriptionText).toContain("Условия");
    expect(v.descriptionText).not.toContain("<");
  });
});
