import { describe, expect, it } from "vitest";
import { createExperienceJs, newExperiencesFrom, renderProposal, SPECIALIZATIONS, type HabrResumeProposal } from "./resume.js";

const job = (company: string, period: string, over: Partial<Parameters<typeof newExperiencesFrom>[0][number]> = {}) => ({ company, role: "Project & Operations Manager", period, summary: "Вёл проекты.", bullets: ["Запустил процесс релизов"], stack: ["Jira", "Kafka"], ...over });

describe("jobs missing on Habr", () => {
  it("only CV jobs Habr lacks (loose name match); facts from the CV; model text wins, else the CV's own; never_claim sentences dropped", () => {
    const { items, notes } = newExperiencesFrom(
      [job("NDA", "Mar 2026 — Present"), job("IVIBIKE", "Sep 2025 — Apr 2026"), job("GeliosSoft", "2022 - 2023"), job("TROFFCONS", "Jan 2025 — Jun 2025"), job("Старая", "2016 - 2017"), job("Темп", "давно")],
      [{ title: "Gelios Soft" }, { title: "ITPROFIT" }, { title: "ТРОФФКОНС", duration: "Январь 2025 — Май 2025  (5 месяцев)" }],
      [{ company: "IVIBIKE", description: "Руководил поддержкой. Писал на Kafka. Снизил время ответа." }],
      { never_claim_skills: ["Kafka"] },
      new Date("2026-10-22"),
    );
    expect(items.map((i) => i.company)).toEqual(["NDA", "IVIBIKE"]); // GeliosSoft is «Gelios Soft» on Habr
    expect(items[0]).toMatchObject({ position: "Project & Operations Manager", period: { start: { y: 2026, m: 3 }, end: null } });
    expect(items[0]!.description).toContain("Запустил процесс релизов"); // no model text: the CV's own
    expect(items[0]!.description).not.toContain("Kafka"); // never_claim in the stack line is dropped
    expect(items[1]!.description).toBe("Руководил поддержкой. Снизил время ответа.");
    // «TROFFCONS» is Habr's «ТРОФФКОНС» (same start); «Старая» (2016) is left to the person
    expect(notes).toEqual([expect.stringContaining("«Старая»"), expect.stringContaining("«Темп»")]);
  });

  it("the form POST carries the CV's dates, specialization and qualification; a current job has no end date", () => {
    const js = createExperienceJs({ company: "NDA", position: "PM", period: { start: { y: 2026, m: 3 }, end: null }, description: "x" }, "<p>x</p>", "32", "4");
    expect(js).toContain('"experience[specialization_id]", "32"');
    expect(js).toContain('"experience[qualification_id]", "4"');
    expect(js).toContain('"experience[start_date(1i)]", "2026"');
    expect(js).toContain('fd.set("presentTime", "on")');
  });

  it("management specializations exist, and the proposal shows the new jobs", () => {
    expect(SPECIALIZATIONS[32]).toBe("Менеджер проекта");
    expect(SPECIALIZATIONS[185]).toBe("Деливери-менеджер");
    const p: HabrResumeProposal = { title: "PM", specializations: [32], qualification: "Middle", about: "a", skills: ["Jira"], experiences: [], notes: [], newExperiences: [{ company: "NDA", position: "PM", period: { start: { y: 2026, m: 3 }, end: null }, description: "d" }] };
    expect(renderProposal(p)).toContain("Менеджер проекта");
    expect(renderProposal(p)).toContain("НОВОЕ место работы - NDA (PM, 03.2026 - по настоящее время)");
  });
});
