import { describe, expect, it } from "vitest";
import { defaultProfile, knownContact } from "../config/profile.js";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { profileForLLM } from "../llm/format.js";
import { DecisionSchema } from "../llm/schemas.js";
import { formatQueueCard } from "../runner/queue-cards.js";
import { addKnownCompany } from "../runner/skills.js";
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

  it("queue card escapes the vitals and the referral line, stays under 4096", () => {
    const card = formatQueueCard(v, "подходит", "П".repeat(2000), "http://pi/u/y/queue#app-1", { fit_score: 70, fit_reason: "<b>Go</b>" }, "Петя <Иванов>");
    expect(card).toContain("fit 70 (&lt;b&gt;Go&lt;/b&gt;)");
    expect(card).toContain("Знакомый: Петя &lt;Иванов&gt; - можно попросить рекомендацию");
    expect(card).not.toContain("<b>Go</b>");
    expect(card.length).toBeLessThan(4096);
    expect(formatQueueCard(v, "", "", "")).not.toContain("Знакомый");
  });
});

describe("referral radar", () => {
  it("matches companies by companyKey on both sides", () => {
    const p = { known_companies: ["Яндекс - Петя, бывший коллега", "Т-Банк - Маша"] };
    expect(knownContact(p, "ООО Яндекс")).toBe("Петя, бывший коллега");
    expect(knownContact(p, "АО «Т-Банк»")).toBe("Маша");
    expect(knownContact(p, "Ozon")).toBe("");
    expect(knownContact(null, "Яндекс")).toBe("");
  });

  it("never sends contacts to the LLM", () => {
    expect(profileForLLM({ ...defaultProfile(), known_companies: ["Яндекс - Петя"] })).not.toHaveProperty("known_companies");
  });

  it("/know appends to the profile of the chat's user, replacing the same company", () => {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    const user = store.listUsers(true)[0]!;
    store.upsertUser({ ...user, tgChatId: "777" });
    store.saveProfile(user.id, { ...defaultProfile(), known_companies: ["Яндекс - Петя"] });
    expect(addKnownCompany(store, "777", "/know Яндекс")).toMatch(/^Формат/);
    expect(addKnownCompany(store, "777", "/know ООО Яндекс — Вася")).toContain("Запомнил");
    expect(addKnownCompany(store, "777", "/know Т-Банк - Маша")).toContain("Запомнил");
    expect(store.getProfile(user.id)!.known_companies).toEqual(["ООО Яндекс - Вася", "Т-Банк - Маша"]);
  });
});
