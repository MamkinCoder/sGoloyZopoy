// verdictJs against a minimal fake DOM: Contact Form 7 statuses first, then new page lines against the text
// before the click (refusal / bot refusal / thank-you), and nothing while the page has not answered yet.
import { describe, expect, it } from "vitest";
import { verdictJs, type SubmitVerdict } from "../../src/career/agent-apply.js";

type Form = { status: string; msg: string };
const run = (opts: { forms?: Form[]; text?: string; before?: string[] }): SubmitVerdict | null => {
  const forms = (opts.forms ?? []).map((f) => ({
    getAttribute: () => f.status,
    querySelector: () => ({ textContent: f.msg }),
  }));
  const document = { querySelectorAll: () => forms, body: { innerText: opts.text ?? "" } };
  return new Function("document", `return ${verdictJs(opts.before ?? [])}`)(document) as SubmitVerdict | null;
};

describe("verdictJs", () => {
  it("reads Contact Form 7's own verdict", () => {
    expect(run({ forms: [{ status: "spam", msg: "При отправке произошла ошибка." }] })).toEqual({ kind: "spam", text: "spam: При отправке произошла ошибка." });
    expect(run({ forms: [{ status: "sent", msg: "Спасибо, резюме получено" }] })).toEqual({ kind: "ok", text: "Спасибо, резюме получено" });
    expect(run({ forms: [{ status: "invalid", msg: "Заполните поле" }] })).toEqual({ kind: "error", text: "invalid: Заполните поле" });
    expect(run({ forms: [{ status: "init", msg: "" }, { status: "failed", msg: "" }] })).toEqual({ kind: "error", text: "failed" });
  });

  it("no answer yet: CF7 still submitting, no new lines", () => {
    expect(run({ forms: [{ status: "submitting", msg: "" }], text: "Вакансия\nОтправить", before: ["Вакансия", "Отправить"] })).toBeNull();
  });

  it("new lines after the click: refusal, bot refusal, thank-you", () => {
    const before = ["Вакансия", "Отправить"];
    expect(run({ text: "Вакансия\nНе удалось отправить форму\nОтправить", before })).toEqual({ kind: "error", text: "Не удалось отправить форму" });
    expect(run({ text: "Вакансия\nПохоже, вы бот. Попробуйте ещё раз", before })).toEqual({ kind: "spam", text: "Похоже, вы бот. Попробуйте ещё раз" });
    expect(run({ text: "Вакансия\nSubmission failed: captcha", before })).toEqual({ kind: "spam", text: "Submission failed: captcha" });
    expect(run({ text: "Вакансия\nСпасибо! Мы свяжемся с вами", before })).toEqual({ kind: "ok", text: "Спасибо! Мы свяжемся с вами" });
  });

  it("lines that were already on the page decide nothing; «работа» is not «бот»", () => {
    expect(run({ text: "Ошибка 404? Сообщите нам\nСпасибо, что читаете", before: ["Ошибка 404? Сообщите нам", "Спасибо, что читаете"] })).toBeNull();
    expect(run({ text: "Ошибка: работа не найдена", before: [] })).toEqual({ kind: "error", text: "Ошибка: работа не найдена" });
  });
});
