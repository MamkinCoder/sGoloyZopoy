import { describe, expect, it } from "vitest";
import { nextJob, TOUCH_EVERY_MS, type AutopilotState } from "./autopilot.js";

const now = Date.parse("2026-09-23T13:00:00Z");
const base: AutopilotState = { now, touchLastAt: new Date(now - 3600_000).toISOString(), careerOn: true, careerDue: () => "y" };

describe("autopilot nextJob", () => {
  it("touch every ~4h, then career chunks", () => {
    expect(nextJob({ ...base, touchLastAt: "" })).toEqual({ kind: "touch" });
    expect(nextJob({ ...base, touchLastAt: new Date(now - TOUCH_EVERY_MS).toISOString() })).toEqual({ kind: "touch" });
    expect(nextJob(base)).toEqual({ kind: "career", userSlug: "y" });
  });

  it("idle when career is off or nothing is due", () => {
    expect(nextJob({ ...base, careerOn: false })).toBeNull();
    expect(nextJob({ ...base, careerDue: () => null })).toBeNull();
  });
});
