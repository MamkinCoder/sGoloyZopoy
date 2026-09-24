// LETTER_LIMIT_JS against a minimal fake DOM: maxlength, a counter near the field, a hint, no limit.
import { describe, expect, it } from "vitest";
import { LETTER_LIMIT_JS } from "../../src/career/agent-apply.js";

type Area = { maxLength: number; placeholder: string; name: string; offsetParent: object | null; parentElement: { textContent: string; parentElement: null } | null; textContent: string; getAttribute: () => null };
const area = (label: string, maxLength = -1, visible = true): Area => ({
  maxLength,
  placeholder: "",
  name: "",
  offsetParent: visible ? {} : null,
  textContent: "",
  parentElement: { textContent: label, parentElement: null },
  getAttribute: () => null,
});
const run = (areas: Area[]): number => new Function("document", `return ${LETTER_LIMIT_JS}`)({ querySelectorAll: () => areas });

describe("LETTER_LIMIT_JS", () => {
  it("reads maxlength of the letter field", () => expect(run([area("Ваш опыт", 2000), area("Сопроводительное письмо", 100)])).toBe(100));
  it("reads a counter or a hint", () => {
    expect(run([area("Комментарий 0 / 500")])).toBe(500);
    expect(run([area("Сообщение (не более 1000 символов)")])).toBe(1000);
  });
  it("no letter field or no limit = 0", () => {
    expect(run([])).toBe(0);
    expect(run([area("Сопроводительное письмо")])).toBe(0);
    expect(run([area("Опыт"), area("Навыки")])).toBe(0);
    expect(run([area("Сопроводительное письмо", 100, false)])).toBe(0);
  });
});
