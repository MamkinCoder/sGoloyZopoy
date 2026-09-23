import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as dalli } from "../../../src/career/ats/sites/dalli.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dalli ats client", () => {
  it("detects the Dalli careers host", () => {
    expect(dalli.detect("https://dalli-service.com/vacancy/", "")).toEqual({ token: "https://dalli-service.com" });
    expect(dalli.detect("https://example.com/careers", "")).toBeNull();
    expect(dalli.detect("https://example.com/careers", "see https://dalli-service.com/vacancy/ for jobs")).toEqual({
      token: "https://dalli-service.com",
    });
  });

  it("lists all jobs from the server-rendered vacancies page", async () => {
    const listHtml = fixture("dalli-vacancies.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await dalli.listJobs("https://dalli-service.com");

    expect(calls).toEqual(["https://dalli-service.com/vacancy/"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:dalli:voditel-kurer-s-lichnym-avtomobilem-moskva",
      url: "https://dalli-service.com/vacancy/voditel-kurer-s-lichnym-avtomobilem-moskva/",
      title: "Водитель-курьер с личным автомобилем (Москва)",
      company: "Dalli",
    });
    expect(jobs[1]).toMatchObject({ externalId: "site:dalli:kladovschik-moskva-tepliy-sklad", title: "Кладовщик (Москва, теплый склад)" });
    expect(jobs[2]).toMatchObject({
      externalId: "site:dalli:podrabotka-po-vykhodnym-voditelem-kurerom-na-lichnom-avtomobile-moskva",
    });
  });

  it("fetches a job's full text and wage from the detail page", async () => {
    const detailHtml = fixture("dalli-vacancy-voditel-kurer-s-lichnym-avtomobilem-moskva.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:dalli:voditel-kurer-s-lichnym-avtomobilem-moskva",
      url: "https://dalli-service.com/vacancy/voditel-kurer-s-lichnym-avtomobilem-moskva/",
      title: "Водитель-курьер с личным автомобилем (Москва)",
      company: "Dalli",
    };
    const vacancy = await dalli.fetchJob("https://dalli-service.com", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Dalli");
    expect(vacancy.descriptionText).toContain("Доставлять клиентам небольшие заказы");
    expect(vacancy.descriptionText).toContain("Требования к кандидатам");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.salaryFrom).toBe(150000);
    expect(vacancy.currency).toBe("RUB");
  });
});
