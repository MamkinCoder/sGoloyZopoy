import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as rostelecom } from "../../../src/career/ats/sites/rostelecom.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/sites/${name}`, import.meta.url)), "utf8");

const listPage = fixture("rostelecom-vacancies.json");
const detailPage = fixture("rostelecom-vacancy-14525.json");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("rostelecom ATS client", () => {
  it("detects by host", () => {
    expect(rostelecom.detect("https://job.rt.ru/", "")).toEqual({ token: "https://job.rt.ru" });
    expect(rostelecom.detect("https://job.rt.ru/search", "")).toEqual({ token: "https://job.rt.ru" });
    expect(rostelecom.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs from the vacancies API, stopping once totalCount is reached", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(listPage));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await rostelecom.listJobs("https://job.rt.ru");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/backend/api/vacancies?page=0&size=100");

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:rostelecom:14547",
      url: "https://job.rt.ru/vacancy/14547",
      title: "Руководитель направления",
      company: "Rostelecom",
      location: "г. Рязань",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:rostelecom:14525", title: "Старший девопс-инженер" });
  });

  it("fetches job detail from the cached listJobs payload, no extra request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(listPage));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await rostelecom.listJobs("https://job.rt.ru");
    const discovered = jobs.find((j) => j.externalId === "site:rostelecom:14525");
    expect(discovered).toBeDefined();
    fetchMock.mockClear();

    const v = await rostelecom.fetchJob("https://job.rt.ru", discovered!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.source).toBe("site:rostelecom");
    expect(v.company).toBe("Rostelecom");
    expect(v.title).toBe("Старший девопс-инженер");
    expect(v.area).toBe("г. Москва");
    expect(v.descriptionText).toContain("Обязанности");
    expect(v.descriptionText).toContain("Настройка прикладного программного обеспечения");
    expect(v.descriptionText).toContain("Требования");
    expect(v.descriptionText).toContain("Продвинутое знание Linux");
    expect(v.descriptionText).toContain("Условия");
    expect(v.descriptionText).not.toContain("<");
    expect(v.salaryFrom).toBe(0);
  });

  it("reports salary when present and falls back to a fresh fetch without cached raw", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(detailPage));
    vi.stubGlobal("fetch", fetchMock);

    const discovered = {
      externalId: "site:rostelecom:14525",
      url: "https://job.rt.ru/vacancy/14525",
      title: "Старший девопс-инженер",
      company: "Rostelecom",
      location: "г. Москва",
    };

    const v = await rostelecom.fetchJob("https://job.rt.ru", discovered);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/backend/api/vacancies/14525");
    expect(v.title).toBe("Старший девопс-инженер");
    expect(v.salaryFrom).toBe(0);
  });
});
