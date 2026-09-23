import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as securityCode } from "../../../src/career/ats/sites/security-code.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("security-code ats client", () => {
  it("detects the Security Code careers host", () => {
    expect(securityCode.detect("https://www.securitycode.ru/company/hr/", "")).toEqual({ token: "https://www.securitycode.ru" });
    expect(securityCode.detect("https://www.securitycode.ru/company/career/", "")).toEqual({ token: "https://www.securitycode.ru" });
    expect(securityCode.detect("https://example.com/careers", "")).toBeNull();
    expect(securityCode.detect("https://www.securitycode.ru/products/vgate/", "")).toBeNull();
  });

  it("lists all jobs from the all.php fragment", async () => {
    const listHtml = fixture("security-code-all.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await securityCode.listJobs("https://www.securitycode.ru");

    expect(calls).toEqual(["https://www.securitycode.ru/company/hr/all.php"]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "site:security-code:spetsialist-po-avtomatizatsii-testirovaniya",
      url: "https://www.securitycode.ru/company/hr/spetsialist-po-avtomatizatsii-testirovaniya/",
      title: "Специалист по автоматизации тестирования",
      company: "Security Code",
      location: "Санкт-Петербург",
    });
    expect(jobs[1]).toMatchObject({
      externalId: "site:security-code:mladshiy-spetsialist-tekhnicheskoy-podderzhki",
      title: "Младший специалист технической поддержки",
      location: "Санкт-Петербург",
    });
  });

  it("fetches a job's full text from the hr_detail block", async () => {
    const detailHtml = fixture("security-code-vacancy.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse(detailHtml)),
    );

    const discovered = {
      externalId: "site:security-code:spetsialist-po-avtomatizatsii-testirovaniya",
      url: "https://www.securitycode.ru/company/hr/spetsialist-po-avtomatizatsii-testirovaniya/",
      title: "Специалист по автоматизации тестирования",
      company: "Security Code",
      location: "Санкт-Петербург",
    };
    const vacancy = await securityCode.fetchJob("https://www.securitycode.ru", discovered);

    expect(vacancy.title).toBe(discovered.title);
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("Security Code");
    expect(vacancy.descriptionText).toContain("Настройкой тестовых лабораторий");
    expect(vacancy.area).toBe("Санкт-Петербург");
    expect(vacancy.descriptionText).not.toContain("<");
  });
});
