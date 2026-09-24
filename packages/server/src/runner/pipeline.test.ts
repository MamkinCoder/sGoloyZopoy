import { describe, expect, it } from "vitest";
import { planCareer, planHabr, planHH } from "./pipeline.js";

describe("run planning", () => {
  it("keeps pool commands isolated from apply/search stages", () => {
    expect(planHH("pool", "sync")).toMatchObject({ poolSync: "force", search: false, apply: false });
    expect(planHH("pool", "expand")).toMatchObject({ poolExpand: true, search: false, chats: false });
    expect(planHH("hh", "apply")).toMatchObject({ poolSync: "auto", search: true, decide: true, apply: true });
  });

  it("maps career stages without accidentally applying during discovery", () => {
    expect(planCareer("career", "discover")).toEqual({ onboardOnly: null, discover: true, apply: false, target: null, rotate: false, siteOnly: null });
    expect(planCareer("all", "onboard:12")).toEqual({ onboardOnly: 12, discover: false, apply: false, target: null, rotate: false, siteOnly: null });
    expect(planCareer("career", "send:7")).toMatchObject({ discover: false, apply: false, target: { applicationId: 7, mode: "send" } });
    expect(planCareer("career", "inspect:7")).toMatchObject({ target: { applicationId: 7, mode: "inspect" } });
    expect(planCareer("career", "site:9")).toMatchObject({ siteOnly: 9, discover: true, apply: true, onboardOnly: null });
    expect(planCareer("career", "force:7")).toMatchObject({ discover: false, target: { applicationId: 7, mode: "force" } });
    expect(planHH("career", "force:7")).toBeNull();
    expect(planHH("hh", "force:7")).toMatchObject({ search: false, apply: false, force: 7 });
    expect(planCareer("hh", "force:7")).toBeNull();
    expect(planCareer("hh", undefined)).toBeNull();
  });

  it("main runs never do chats; only stage chats does (hh + habr)", () => {
    for (const src of ["hh", "all"]) {
      expect(planHH(src, undefined)).toMatchObject({ chats: false, apply: true });
      expect(planHH(src, "apply")).toMatchObject({ chats: false });
    }
    for (const src of ["habr", "all"]) expect(planHabr(src, undefined)).toMatchObject({ chats: false, apply: true });
    expect(planHH("all", "chats")).toMatchObject({ chats: true, apply: false, search: false });
    expect(planHabr("all", "chats")).toMatchObject({ chats: true, apply: false });
    expect(planCareer("all", "chats")).toBeNull();
  });

  it("the scheduled full run (all, no stage) skips career sites; --source career still runs them", () => {
    expect(planCareer("all", undefined)).toBeNull();
    expect(planCareer("career", undefined)).toMatchObject({ discover: true, apply: true });
  });
});
