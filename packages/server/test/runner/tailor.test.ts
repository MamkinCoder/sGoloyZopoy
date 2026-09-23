import { describe, expect, it, vi } from "vitest";
import type { BrowserSession, Decision, HHResume, User } from "@sgz/shared";
import type { RunContext } from "../../src/runner/context.js";
import type { UserRun } from "../../src/runner/user.js";
import { tailorResume } from "../../src/runner/hh.js";

const row = (id: number, hh: string, title: string, direction: string, isGenerated = false): HHResume => ({
  id, userId: 1, hhResumeId: hh, title, url: `https://hh.ru/resume/${hh}`, direction, summary: null, isGenerated, syncedAt: "",
});
const decision: Decision = {
  vacancy_id: 1, apply: true, reason: "", resume_id: "go1", cover_letter: "", direction: "react", seniority: "middle", red_flags: [],
  resume_fit: "poor", tailored: { title: "React-разработчик", about: "Пишу на React.", key_skills: ["React", "TypeScript"] },
};

function setup(cap: { created: number; max: number }, over: { dryRun?: boolean; fail?: boolean; published?: boolean } = {}) {
  const saved: HHResume[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const hh = {
    resumeCapacity: vi.fn(async () => cap),
    duplicateResume: vi.fn(async () => { if (over.fail) throw new Error("boom"); return "new1"; }),
    editResume: vi.fn(async () => { if (over.fail) throw new Error("boom"); }),
    publishResume: vi.fn(async () => over.published ?? true),
  };
  const ctx = {
    hh, log,
    cfg: { tz: "Europe/Moscow" },
    req: { dryRun: !!over.dryRun },
    now: () => new Date("2026-09-23T10:00:00Z"),
    throttle: { afterMutation: vi.fn(async () => {}) },
    store: {
      countHHResumesCreatedToday: () => 0,
      upsertHHResume: (r: Omit<HHResume, "id"> & { id?: number }) => { const out = { ...r, id: r.id ?? 99 }; saved.push(out); return out; },
    },
  } as unknown as RunContext;
  const u = { user: { id: 1, poolExpandPerDay: 2 } as User } as UserRun;
  const base = row(1, "go1", "Go-разработчик", "go-backend");
  const gen = row(2, "gen1", "Node.js-разработчик", "go-backend", true);
  const pool = [base, gen];
  const run = (lock = "") => tailorResume(ctx, u, {} as BrowserSession, decision, base, pool, lock);
  return { hh, log, saved, pool, base, gen, run };
}

describe("tailorResume", () => {
  it("free capacity: duplicates the chosen resume and returns the new row", async () => {
    const t = setup({ created: 3, max: 20 });
    const r = await t.run();
    expect(t.hh.duplicateResume).toHaveBeenCalledWith({}, "go1", { title: "React-разработчик", about: "Пишу на React.", keySkills: ["React", "TypeScript"] });
    expect(r).toMatchObject({ hhResumeId: "new1", title: "React-разработчик", direction: "react", isGenerated: true });
    expect(t.pool).toContain(r);
  });

  it("full capacity: never edits a resume already sent anywhere, applies with the original", async () => {
    const t = setup({ created: 20, max: 20 });
    const r = await t.run();
    expect(t.hh.duplicateResume).not.toHaveBeenCalled();
    expect(t.hh.editResume).not.toHaveBeenCalled();
    expect(r).toBe(t.base);
    expect(t.saved).toHaveLength(0);
  });

  it("a copy hh didn't publish is never sent: falls back to the original", async () => {
    const t = setup({ created: 3, max: 20 }, { published: false });
    expect(await t.run()).toBe(t.base);
    expect(t.hh.publishResume).toHaveBeenCalledWith({}, "new1");
  });

  it("failure falls back to the original resume", async () => {
    const t = setup({ created: 3, max: 20 }, { fail: true });
    expect(await t.run()).toBe(t.base);
    expect(t.log.warn).toHaveBeenCalled();
    expect(t.saved).toHaveLength(0);
  });

  it("dry run and a conflicting persona lock change nothing", async () => {
    const dry = setup({ created: 3, max: 20 }, { dryRun: true });
    expect(await dry.run()).toBe(dry.base);
    const locked = setup({ created: 3, max: 20 });
    expect(await locked.run("go-backend")).toBe(locked.base);
    for (const t of [dry, locked]) {
      expect(t.hh.duplicateResume).not.toHaveBeenCalled();
      expect(t.hh.editResume).not.toHaveBeenCalled();
    }
  });
});
