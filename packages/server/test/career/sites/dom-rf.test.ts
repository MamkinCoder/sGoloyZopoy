import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as domRf } from "../../../src/career/ats/sites/dom-rf.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const jsonResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dom-rf ats client", () => {
  it("detects the ДОМ.РФ careers host", () => {
    expect(domRf.detect("https://xn--d1aqf.xn--p1ai/career/vacancies/", "")).toEqual({ token: "https://xn--d1aqf.xn--p1ai" });
    expect(domRf.detect("https://example.com/careers", "")).toBeNull();
    expect(domRf.detect("https://career.domrf.ru/", "xn--d1aqf.xn--p1ai/career/vacancies")).toEqual({ token: "https://xn--d1aqf.xn--p1ai" });
  });

  it("lists all jobs across paginated list API calls", async () => {
    const page1 = fixture("dom-rf-vacancies-page1.json");
    const page2 = fixture("dom-rf-vacancies-page2.json");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return jsonResponse(url.includes("page=2") ? page2 : page1);
      }),
    );

    const jobs = await domRf.listJobs("https://xn--d1aqf.xn--p1ai");

    expect(calls).toEqual([
      "https://xn--d1aqf.xn--p1ai/api/v2/content/career/vacancies/list/?page=1",
      "https://xn--d1aqf.xn--p1ai/api/v2/content/career/vacancies/list/?page=2",
    ]);
    expect(jobs).toHaveLength(5);
    expect(jobs[0]).toMatchObject({
      externalId: "site:dom-rf:615127",
      url: "https://xn--d1aqf.xn--p1ai/career/vacancy/615127/",
      title: "DevOps эксперт по сопровождению инструментов платформы безопасной разработки/Безопасная разработка систем/Информационная безопасность",
      company: "АО «БАНК ДОМ.РФ»",
      location: "Москва",
    });
    expect(jobs[3]).toMatchObject({ externalId: "site:dom-rf:627421", title: "Разработчик PHP (Цифровые сервисы Земли и Девелопмента)/ИТ", company: "ПАО ДОМ.РФ" });
  });

  it("fetches a job's full text from the embedded detail JSON", async () => {
    const detailHtml = fixture("dom-rf-vacancy-627421.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:dom-rf:627421",
      url: "https://xn--d1aqf.xn--p1ai/career/vacancy/627421/",
      title: "Разработчик PHP (Цифровые сервисы Земли и Девелопмента)/ИТ",
      company: "ПАО ДОМ.РФ",
    };
    const vacancy = await domRf.fetchJob("https://xn--d1aqf.xn--p1ai", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("ПАО ДОМ.РФ");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.descriptionText).toContain("Разрабатывать новый функционал, модули и компоненты внутренних бизнес приложений на 1C Bitrix/Bitrix24 и Laravel");
    expect(vacancy.descriptionText).toContain("Опыт коммерческой разработки на PHP от 3 лет");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.descriptionText).not.toContain("&nbsp;");
  });

  it("falls back to the discovered title/company when the detail block is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse("<html><body>no data here</body></html>")),
    );

    const discovered = {
      externalId: "site:dom-rf:999999",
      url: "https://xn--d1aqf.xn--p1ai/career/vacancy/999999/",
      title: "Some Title",
      company: "ДОМ.РФ",
    };
    const vacancy = await domRf.fetchJob("https://xn--d1aqf.xn--p1ai", discovered);

    expect(vacancy.title).toBe("Some Title");
    expect(vacancy.company).toBe("ДОМ.РФ");
    expect(vacancy.descriptionText).toBe("");
  });
});
