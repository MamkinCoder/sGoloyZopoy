import { describe, expect, it } from "vitest";
import { splitName } from "../../src/career/ats/apply-common.js";
import { cvFileName } from "../../src/career/agent-apply.js";

describe("career apply helpers", () => {
  it("splits Russian names in either order and latin names first-last", () => {
    for (const [full, first, last] of [
      ["Иван Петров", "Иван", "Петров"],
      ["Петров Иван", "Иван", "Петров"],
      ["Алина Смирнова", "Алина", "Смирнова"],
      ["Смирнова Алина", "Алина", "Смирнова"],
      ["Иванов Иван Иванович", "Иван", "Иванов"],
      ["John Smith", "John", "Smith"],
    ]) expect(splitName(full!)).toEqual({ first, last });
  });

  it("names the uploaded CV after the person, not the internal id", () => {
    expect(cvFileName("Иван Петров")).toBe("Петров_Иван_CV.pdf");
  });
});
