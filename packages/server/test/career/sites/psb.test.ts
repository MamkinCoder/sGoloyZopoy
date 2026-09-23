import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as psb } from "../../../src/career/ats/sites/psb.js";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/sites/${name}`, import.meta.url)), "utf8");

const listPage0 = fixture("psb-vacancies-page0.json");
const detail4473 = fixture("psb-vacancy-4473.json");

afterEach(() => vi.unstubAllGlobals());

describe("psb ATS client", () => {
  it("detects by host", () => {
    expect(psb.detect("https://job.psbank.ru/", "")).toEqual({ token: "job.psbank.ru" });
    expect(psb.detect("https://job.psbank.ru/vacancies", "")).toEqual({ token: "job.psbank.ru" });
    expect(psb.detect("https://example.com/", "")).toBeNull();
  });

  it("lists jobs from the paginated content API", async () => {
    const fetchMock = vi.fn(async () => new Response(listPage0, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await psb.listJobs("job.psbank.ru");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/content/vacancies?page=0");

    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:psb:4473",
      url: "https://job.psbank.ru/vacancies/4473",
      title: "Frontend-разработчик",
      company: "PSB",
    });
    expect(jobs[1]?.location).toBeUndefined();
    expect(jobs[2]?.title).toBe("Специалист по продажам юридическим лицам");
  });

  it("fetches job detail from the cached listJobs payload when it already has locationName", async () => {
    const fetchMock = vi.fn(async () => new Response(detail4473, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const v = await psb.fetchJob("job.psbank.ru", {
      externalId: "site:psb:4473",
      url: "https://job.psbank.ru/vacancies/4473",
      title: "Frontend-разработчик",
      company: "PSB",
      raw: JSON.parse(detail4473),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(v.source).toBe("site:psb");
    expect(v.company).toBe("PSB");
    expect(v.title).toBe("Frontend-разработчик");
    expect(v.descriptionText).toContain("Обязанности");
    expect(v.descriptionText).toContain("Требования");
    expect(v.descriptionText).toContain("Angular SPA");
    expect(v.area).toBe("Москва");
    expect(v.workFormat).toBe("полная занятость");
    expect(v.salaryFrom).toBe(0);
    expect(v.currency).toBe("");
  });

  it("falls back to the detail endpoint when raw lacks locationName (e.g. resumed from storage)", async () => {
    const fetchMock = vi.fn(async () => new Response(detail4473, { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const v = await psb.fetchJob("job.psbank.ru", {
      externalId: "site:psb:4473",
      url: "https://job.psbank.ru/vacancies/4473",
      title: "Frontend-разработчик",
      company: "PSB",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://job.psbank.ru/api/v1/content/vacancies/4473");
    expect(v.area).toBe("Москва");
  });

  it("reports a positive salary with RUB currency", async () => {
    const raw = { ...JSON.parse(listPage0).data[1], locationName: "Ростов-на-Дону" };
    const v = await psb.fetchJob("job.psbank.ru", {
      externalId: "site:psb:4049",
      url: "https://job.psbank.ru/vacancies/4049",
      title: "QA инженер (Python)",
      company: "PSB",
      raw,
    });
    expect(v.salaryFrom).toBe(180000);
    expect(v.currency).toBe("RUB");
  });
});
