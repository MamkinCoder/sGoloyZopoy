import { describe, expect, it, vi } from "vitest";
import { askMissingSkills, handleSkillAskTap, parseSkillAskCallback } from "./skill-ask.js";

function setup(tags: { id: number; name: string; aliases: string[]; status: string }[] = []) {
  const settings = new Map<string, string>();
  const statuses = new Map<number, string>();
  const asked: string[] = [];
  const store = {
    getSetting: (k: string) => settings.get(k) ?? null,
    setSetting: (k: string, v: string) => void settings.set(k, v),
    listKbTags: () => tags,
    upsertKbTag: (_u: number, t: { name: string; status: string }) => {
      const row = { id: tags.length + 10, aliases: [], ...t };
      tags.push(row);
      return row;
    },
    setKbTagStatus: (id: number, s: string) => void statuses.set(id, s),
    getProfile: () => null,
    listUsers: () => [user],
    getApplication: () => ({ application: { userId: 1 }, vacancy: { source: "hh", url: "u" } }),
  };
  const notifier = { ask: vi.fn(async (t: string) => (asked.push(t), 7)) };
  const user = { id: 1, slug: "a", tgChatId: "5" } as never;
  return { store: store as never, notifier: notifier as never, user, statuses, asked, settings, raw: store };
}

describe("skill questions for rejected vacancies", () => {
  it("asks only unknown skills, once per application", async () => {
    const s = setup([{ id: 1, name: "SQL", aliases: [], status: "yes" }, { id: 2, name: "Java", aliases: [], status: "no" }]);
    expect(await askMissingSkills(s.store, s.notifier, s.user, { title: "PM", company: "X" }, 5, ["SQL", "Java"])).toBe(false);
    expect(await askMissingSkills(s.store, s.notifier, s.user, { title: "PM", company: "X" }, 5, ["Jira", "Kaiten"])).toBe(true);
    expect(await askMissingSkills(s.store, s.notifier, s.user, { title: "PM", company: "X" }, 5, ["Jira"])).toBe(false);
    expect(s.asked[0]).toContain("Jira");
  });

  it("all yes applies, any no skips, answers are kept as tag statuses", async () => {
    const start = vi.fn(async () => 1);
    const s = setup();
    await askMissingSkills(s.store, s.notifier, s.user, { title: "PM", company: "X" }, 5, ["Jira", "Kaiten"]);
    const first = await handleSkillAskTap(s.store, { start } as never, { appId: 5, i: 0, yes: true });
    expect(start).not.toHaveBeenCalled();
    expect(first).toMatchObject({ note: "✅" });
    await handleSkillAskTap(s.store, { start } as never, { appId: 5, i: 1, yes: true });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ stage: "force:5", source: "hh" }));
    expect([...s.statuses.values()]).toEqual(["yes", "yes"]);
    expect(await handleSkillAskTap(s.store, { start } as never, { appId: 5, i: 1, yes: false })).toBe("уже отвечено");
  });

  it("a «нет» does not apply", async () => {
    const start = vi.fn();
    const s = setup();
    await askMissingSkills(s.store, s.notifier, s.user, { title: "PM", company: "X" }, 6, ["Java"]);
    await handleSkillAskTap(s.store, { start } as never, { appId: 6, i: 0, yes: false });
    expect(start).not.toHaveBeenCalled();
    expect(parseSkillAskCallback("ms:6:0:n")).toEqual({ appId: 6, i: 0, yes: false });
  });
});
