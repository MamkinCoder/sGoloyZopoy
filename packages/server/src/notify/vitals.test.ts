import { describe, expect, it } from "vitest";
import { DecisionSchema } from "../llm/schemas.js";
import { formatQueueCard } from "../runner/queue-cards.js";
import { fitOf, vitalsLine } from "./format.js";

const v = { title: "Go <dev>", company: "ООО «Яндекс»", url: "https://x.ru/1", salaryFrom: 250000, salaryTo: 0, currency: "RUR", workFormat: "Удалённо" };

describe("fit score + vitals", () => {
  it("parses old decisions without a fit and clamps garbage to none", () => {
    const base = { vacancy_id: 1, apply: true };
    expect(DecisionSchema.parse(base).fit_score).toBeUndefined();
    expect(fitOf(DecisionSchema.parse({ ...base, fit_score: 81.6, fit_reason: " Go+K8s " }))).toEqual({ fit_score: 82, fit_reason: "Go+K8s" });
    expect(fitOf(null)).toEqual({ fit_score: null, fit_reason: "" });
    expect(DecisionSchema.parse({ ...base, fit_score: 150 }).fit_score).toBeUndefined();
    expect(DecisionSchema.parse({ ...base, fit_score: null }).fit_score).toBeUndefined();
    expect(DecisionSchema.parse({ ...base, fit_score: "high" }).fit_score).toBeUndefined();
  });

  it("builds one vitals line and skips missing parts", () => {
    expect(vitalsLine(v, { fit_score: 82, fit_reason: "Go+K8s, вилка ок" })).toBe("от 250 000 RUR · удалёнка · fit 82 (Go+K8s, вилка ок)");
    expect(vitalsLine({ salaryFrom: 0, salaryTo: 0, currency: "", workFormat: "Полная занятость" }, null)).toBe("");
    expect(vitalsLine({ salaryFrom: 0, salaryTo: 300000, currency: "RUR", workFormat: "hybrid" }, { fit_score: 40 })).toBe("до 300 000 RUR · гибрид · fit 40");
  });

  it("queue card escapes the vitals line, stays under 4096", () => {
    const card = formatQueueCard(v, "подходит", "П".repeat(2000), "http://pi/u/y/queue#app-1", { fit_score: 70, fit_reason: "<b>Go</b>" });
    expect(card).toContain("fit 70 (&lt;b&gt;Go&lt;/b&gt;)");
    expect(card).not.toContain("<b>Go</b>");
    expect(card.length).toBeLessThan(4096);
  });
});
