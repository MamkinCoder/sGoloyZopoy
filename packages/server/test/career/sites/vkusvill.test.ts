import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client as vkusvill } from "../../../src/career/ats/sites/vkusvill.js";

const FIXTURES = join(__dirname, "..", "fixtures", "sites");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const htmlResponse = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vkusvill ats client", () => {
  it("detects the VkusVill job section by host+path or by html", () => {
    expect(vkusvill.detect("https://vkusvill.ru/job/office/", "")).toEqual({ token: "https://vkusvill.ru" });
    expect(vkusvill.detect("https://vkusvill.ru/job/vacancys/foo_123.html", "")).toEqual({ token: "https://vkusvill.ru" });
    expect(vkusvill.detect("https://vkusvill.ru/", "")).toBeNull();
    expect(vkusvill.detect("https://example.com/", "goes to vkusvill.ru/job/vacancys/foo_1.html")).toEqual({ token: "https://vkusvill.ru" });
  });

  it("lists all open jobs from the office category page", async () => {
    const listHtml = fixture("vkusvill-office.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(listHtml);
      }),
    );

    const jobs = await vkusvill.listJobs("https://vkusvill.ru");

    expect(calls).toEqual(["https://vkusvill.ru/job/office/"]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      externalId: "site:vkusvill:136352544",
      url: "https://vkusvill.ru/job/vacancys/key_account_manager_kam_136352544.html",
      title: "Key Account Manager (KAM)",
      company: "VkusVill",
      location: "Москва",
    });
    expect(jobs[2]).toMatchObject({
      externalId: "site:vkusvill:137307448",
      title: "Robotics Software Engineer (Роботизация дарксторов)",
    });
  });

  it("fetches a job's full text from the detail page JSON-LD", async () => {
    const detailHtml = fixture("vkusvill-job-137307448.html");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return htmlResponse(detailHtml);
      }),
    );

    const discovered = {
      externalId: "site:vkusvill:137307448",
      url: "https://vkusvill.ru/job/vacancys/robotics_software_engineer_robotizatsiya_darkstorov_137307448.html",
      title: "Robotics Software Engineer (Роботизация дарксторов)",
      company: "VkusVill",
      location: "Москва",
    };
    const vacancy = await vkusvill.fetchJob("https://vkusvill.ru", discovered);

    expect(calls).toEqual([discovered.url]);
    expect(vacancy.title).toBe("Robotics Software Engineer (Роботизация дарксторов) - Москва");
    expect(vacancy.url).toBe(discovered.url);
    expect(vacancy.company).toBe("VkusVill");
    expect(vacancy.area).toBe("Москва");
    expect(vacancy.salaryFrom).toBe(460000);
    expect(vacancy.descriptionText).toContain("Разработка связующего ПО на ROS 2");
    expect(vacancy.descriptionText).not.toContain("<");
    expect(vacancy.publishedAt).toBe(new Date("2026-09-15").toISOString());
  });
});
