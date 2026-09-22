import { describe, expect, it } from "vitest";
import { Status } from "@sgz/shared";
import { createHHClient } from "../../src/hh/client.js";
import { FakeSession, fixture } from "./fake-session.js";

const client = createHHClient({ snapshotDir: "/tmp/sgz-hh-test", settleMs: 0, confirmTimeoutMs: 10 });

const vacancy = {
  id: 1,
  source: "hh" as const,
  externalId: "111",
  url: "https://hh.ru/vacancy/111",
  title: "Go разработчик",
  company: "ООО Ромашка",
  salaryFrom: 150000,
  salaryTo: 200000,
  currency: "RUR",
  descriptionText: "Ищем Go разработчика.",
  hasTest: false,
  requiresLetter: true,
  area: "Москва",
  workFormat: "Удалённо",
  publishedAt: null,
  firstSeenAt: "2026-09-22T00:00:00Z",
  lastSeenAt: "2026-09-22T00:00:00Z",
  archived: false,
  dedupHash: "x",
};

describe("hh client offline flows", () => {
  it("detects login expiry and captcha as fatal blocks", async () => {
    const login = new FakeSession({ "https://hh.ru/applicant/resumes": { redirect: "https://hh.ru/account/login?role=applicant" } });
    expect(await client.checkLogin(login)).toBe(false);
    const captcha = new FakeSession({ "https://hh.ru/captcha": { text: "Подтвердите, что вы не робот" } });
    await captcha.goto("https://hh.ru/captcha");
    await expect(client.assertNotBlocked(captcha)).rejects.toMatchObject({ status: Status.FAILED_CAPTCHA });
  });

  it("reads vacancy state from the recorded InitialState fixture", async () => {
    const s = new FakeSession({ "https://hh.ru/vacancy/111": { html: fixture("vacancy.html") } });
    const result = await client.fetchVacancy(s, { externalId: "111", url: "https://hh.ru/vacancy/111", title: "", company: "", salaryRaw: "" });
    expect(result.alreadyApplied).toBe(false);
    expect(result.vacancy).toMatchObject({ externalId: "111", title: "Go разработчик", company: "ООО Ромашка", requiresLetter: true, hasTest: false, salaryFrom: 130500, salaryTo: 217500, currency: "RUR" });
    expect(result.vacancy.descriptionText).toContain("Go, PostgreSQL");
  });

  it("dry-run opens the response form but never submits or sends chat", async () => {
    const s = new FakeSession(
      { "https://hh.ru/vacancy/111": { html: fixture("vacancy.html"), existing: ['[data-qa="vacancy-response-link-top"]', '[data-qa="resume-select-radio"]', '[data-qa="vacancy-response-questions"]'] } },
      { onExtract: () => ({ questions: [{ text: "Готовы?", kind: "radio", options: ["Да"], required: true }] }) },
    );
    const result = await client.apply(s, { vacancy, resumeTitle: "Go", coverLetter: "Здравствуйте.", allowOtherCountry: false, dryRun: true, answerQuestions: async () => [] });
    expect(result.status).toBe(Status.SKIP_DRY_RUN);
    expect(result.questions).toHaveLength(1);
    expect(s.methods()).toContain("click");
    expect(s.methods()).toContain("pressEscape");
    expect(s.calls.some((c) => c.method === "click" && String(c.args[0]).includes("submit"))).toBe(false);
    expect(s.calls.some((c) => c.method === "act" && /отправки|отправки отклика|сообщения/.test(String(c.args[0])))).toBe(false);
  });
});
