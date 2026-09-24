import { describe, expect, it, vi } from "vitest";
import { RunAbortError, Status, type RunRequest } from "@sgz/shared";
import type { RunContext } from "./context.js";
import { planCareer, planHabr, planHH, runPipeline } from "./pipeline.js";

const calls: string[] = [];
let hhError: Error | null = null;
let careerError: Error | null = null;
vi.mock("./hh.js", () => ({ runHHUser: async () => (calls.push("hh"), hhError && Promise.reject(hhError)) }));
vi.mock("./habr.js", () => ({ runHabrUser: async () => void calls.push("habr") }));
vi.mock("./career.js", () => ({ runCareerUser: async () => (calls.push("career"), careerError && Promise.reject(careerError)) }));

function pipelineCtx(req: Partial<RunRequest>) {
  const settings = new Map<string, string>();
  const alert = vi.fn(async () => {});
  const ctx = {
    req: { userSlug: "y", source: "all", dryRun: false, limit: 0, trigger: "schedule", ...req } as RunRequest,
    store: {
      getUserBySlug: () => ({ id: 1, slug: "y", name: "Y" }),
      getProfile: () => ({}),
      getSetting: (k: string) => settings.get(k) ?? null,
      setSetting: (k: string, v: string) => void settings.set(k, v),
    },
    deps: { habr: {}, notifier: { alert } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    run: { id: 7 },
    now: () => new Date("2026-09-24T10:00:00Z"),
    checkAbort: () => {},
    browser: { close: async () => {} },
  } as unknown as RunContext;
  return { ctx, alert };
}

describe("runPipeline error containment", () => {
  it("the daily run still does Habr when hh fails, then reports the hh failure", async () => {
    calls.length = 0;
    hhError = new RunAbortError(Status.FAILED_LOGIN_EXPIRED, "hh login expired");
    const { ctx, alert } = pipelineCtx({});
    const r = await runPipeline(ctx);
    hhError = null;
    expect(calls).toEqual(["hh", "habr"]);
    expect(r).toMatchObject({ status: "stopped", error: expect.stringContaining("FAILED_LOGIN_EXPIRED") });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("an autopilot chunk failing the same way alerts once, not on every chunk", async () => {
    calls.length = 0;
    careerError = new RunAbortError(Status.FAILED_LOW_MEMORY, "MemAvailable 150 MB");
    const { ctx, alert } = pipelineCtx({ source: "career", stage: "rotate" });
    await runPipeline(ctx);
    await runPipeline(ctx);
    careerError = null;
    expect(calls).toEqual(["career", "career"]);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

describe("run planning", () => {
  it("keeps pool commands isolated from apply/search stages", () => {
    expect(planHH("pool", "sync")).toMatchObject({ poolSync: "force", search: false, apply: false });
    expect(planHH("pool", "expand")).toMatchObject({ poolExpand: true, search: false });
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

  it("runs never do chats: stage chats is gone (the always-on agent answers employers)", () => {
    expect(planHH("all", "chats")).toBeNull();
    expect(planHabr("all", "chats")).toBeNull();
    expect(planCareer("all", "chats")).toBeNull();
  });

  it("the scheduled full run (all, no stage) skips career sites; --source career still runs them", () => {
    expect(planCareer("all", undefined)).toBeNull();
    expect(planCareer("career", undefined)).toMatchObject({ discover: true, apply: true });
  });
});
