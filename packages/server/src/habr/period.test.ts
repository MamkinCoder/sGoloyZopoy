import { describe, expect, it } from "vitest";
import { parsePeriod } from "./period.js";

describe("parsePeriod", () => {
  it("reads the formats the base CVs use", () => {
    expect(parsePeriod("Mar 2026 — Present")).toEqual({ start: { y: 2026, m: 3 }, end: null });
    expect(parsePeriod("Sep 2025 — Apr 2026")).toEqual({ start: { y: 2025, m: 9 }, end: { y: 2026, m: 4 } });
    expect(parsePeriod("Декабрь 2025 - н.в.")).toEqual({ start: { y: 2025, m: 12 }, end: null });
    expect(parsePeriod("Февраль 2024 - Август 2025")).toEqual({ start: { y: 2024, m: 2 }, end: { y: 2025, m: 8 } });
    expect(parsePeriod("03.2024 – 11.2025")).toEqual({ start: { y: 2024, m: 3 }, end: { y: 2025, m: 11 } });
  });
  it("years only: January to December; nothing parsable: null", () => {
    expect(parsePeriod("2019–2022")).toEqual({ start: { y: 2019, m: 1 }, end: { y: 2022, m: 12 } });
    expect(parsePeriod("2019")).toEqual({ start: { y: 2019, m: 1 }, end: { y: 2019, m: 12 } });
    expect(parsePeriod("давно")).toBeNull();
  });
});
