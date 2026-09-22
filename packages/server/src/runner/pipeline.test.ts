import { describe, expect, it } from "vitest";
import { planCareer, planHH } from "./pipeline.js";

describe("run planning", () => {
  it("keeps pool commands isolated from apply/search stages", () => {
    expect(planHH("pool", "sync")).toMatchObject({ poolSync: "force", search: false, apply: false });
    expect(planHH("pool", "expand")).toMatchObject({ poolExpand: true, search: false, chats: false });
    expect(planHH("hh", "apply")).toMatchObject({ poolSync: "auto", search: true, decide: true, apply: true });
  });

  it("maps career stages without accidentally applying during discovery", () => {
    expect(planCareer("career", "discover")).toEqual({ onboardOnly: null, discover: true, apply: false });
    expect(planCareer("all", "onboard:12")).toEqual({ onboardOnly: 12, discover: false, apply: false });
    expect(planCareer("hh", undefined)).toBeNull();
  });
});
