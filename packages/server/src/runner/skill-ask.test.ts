import { describe, expect, it, vi } from "vitest";
import { afterSkill, askMissingSkills, handleSkillAskTap, parseSkillAskCallback, startPendingForce } from "./skill-ask.js";

function setup(tags: { id: number; name: string; aliases: string[]; status: string }[] = [], active = false) {
  const settings = new Map<string, string>();
  const statuses = new Map<number, string>();
  const asked: string[] = [];
  const user = { id: 1, slug: "a", tgChatId: "5" } as never;
  const store = {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string) => void settings.set(k, v),
    listKbTags: () => tags,
    upsertKbTag: (_u: number, t: { name: string; status: string }) => {
      const row = { id: tags.length + 10, aliases: [], ...t };
      tags.push(row);
      return row;
    },
    setKbTagStatus: (id: number, s: string) => {
      statuses.set(id, s);
      const t = tags.find((x) => x.id === id);
      if (t) t.status = s;
    },
    getProfile: () => null,
    listUsers: () => [user],
    hasSentApplication: () => false,
    getApplication: () => ({ application: { userId: 1 }, vacancy: { id: 9, source: "hh", url: "u" } }),
  };
  const notifier = { ask: vi.fn(async (t: string) => (asked.push(t), 7)), edit: vi.fn(async () => undefined) };
  const start = vi.fn(async () => 1);
  const deps = { store, notifier, runner: { start, active: () => (active ? ({ id: 1 } as never) : null) } } as never;
  return { store: store as never, notifier: notifier as never, deps, start, user, statuses, asked, settings, edit: notifier.edit };
}
const v = { title: "PM", company: "X" };

describe("skill questions for rejected vacancies", () => {
  it("asks only unknown skills, once per application", async () => {
    const s = setup([{ id: 1, name: "SQL", aliases: [], status: "yes" }, { id: 2, name: "Java", aliases: [], status: "no" }]);
    expect(await askMissingSkills(s.store, s.notifier, s.user, v, 5, ["SQL", "Java"])).toBe(false);
    expect(await askMissingSkills(s.store, s.notifier, s.user, v, 5, ["Jira", "Kaiten"])).toBe(true);
    expect(await askMissingSkills(s.store, s.notifier, s.user, v, 5, ["Jira"])).toBe(false);
    expect(s.asked[0]).toContain("Jira");
  });

  it("all yes applies, any no skips, answers are kept as tag statuses", async () => {
    const s = setup();
    await askMissingSkills(s.store, s.notifier, s.user, v, 5, ["Jira", "Kaiten"]);
    expect(await handleSkillAskTap(s.deps, { appId: 5, i: 0, op: "y" })).toMatchObject({ note: "✅" });
    expect(s.start).not.toHaveBeenCalled();
    await handleSkillAskTap(s.deps, { appId: 5, i: 1, op: "y" });
    expect(s.start).toHaveBeenCalledWith(expect.objectContaining({ stage: "force:5", source: "hh" }));
    expect([...s.statuses.values()]).toEqual(["yes", "yes"]);
    expect(await handleSkillAskTap(s.deps, { appId: 5, i: 1, op: "n" })).toBe("уже отвечено");
  });

  it("a «нет» does not apply", async () => {
    const s = setup();
    await askMissingSkills(s.store, s.notifier, s.user, v, 6, ["Java"]);
    await handleSkillAskTap(s.deps, { appId: 6, i: 0, op: "n" });
    expect(s.start).not.toHaveBeenCalled();
    expect(parseSkillAskCallback("ms:6:0:w")).toEqual({ appId: 6, i: 0, op: "w" });
  });

  it("a busy bot parks the application and the autopilot applies later, no manual step", async () => {
    const s = setup([], true);
    await askMissingSkills(s.store, s.notifier, s.user, v, 7, ["Jira"]);
    const r = await handleSkillAskTap(s.deps, { appId: 7, i: 0, op: "y" });
    expect(JSON.stringify(r)).toContain("откликнусь сам");
    expect(s.start).not.toHaveBeenCalled();
    expect(await startPendingForce(s.store, { start: s.start, active: () => null })).toBe(true);
    expect(s.start).toHaveBeenCalledWith(expect.objectContaining({ stage: "force:7" }));
    expect(await startPendingForce(s.store, { start: s.start, active: () => null })).toBe(false);
  });

  it("«✍️» waits for a story in the personal chat; once the hub saved it the skill counts as «есть» and the card applies", async () => {
    const s = setup();
    await askMissingSkills(s.store, s.notifier, s.user, v, 8, ["Kaiten"]);
    const r = await handleSkillAskTap(s.deps, { appId: 8, i: 0, op: "w" });
    expect(JSON.stringify(r)).toContain("в личке");
    expect(JSON.parse(s.settings.get("skills_wait:5")!)).toMatchObject({ kind: "more" });
    const tagId = JSON.parse(s.settings.get("skills_wait:5")!).tagId as number;
    await afterSkill(s.deps, 1, tagId);
    expect(s.start).toHaveBeenCalledWith(expect.objectContaining({ stage: "force:8" }));
    expect(s.edit).toHaveBeenCalled();
  });
});
