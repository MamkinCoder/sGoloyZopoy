import { describe, expect, it } from "vitest";
import { defaultProfile } from "../config/profile.js";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { askSkill, learnedSkills, parseSkillCallback, resolveSkill, skillCallback, threadWaiting, withLearnedSkills } from "./skills.js";

describe("unknown-skill approvals", () => {
  it("asks once, holds the thread, and moves the skill to the answered list", () => {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    const user = store.listUsers(true)[0]!;
    store.saveProfile(user.id, { ...defaultProfile(), verified_skills: ["Go"], never_claim_skills: [] });

    expect(askSkill(store, user.id, 11, "Kafka")).toBe(true);
    expect(askSkill(store, user.id, 12, "kafka")).toBe(false); // same skill from another chat: no second prompt
    expect(threadWaiting(store, user.id, 11)).toBe(true);
    expect(threadWaiting(store, user.id, 12)).toBe(true);

    const cb = parseSkillCallback(skillCallback(true, user.id, "Kafka"))!;
    expect(Buffer.byteLength(skillCallback(true, user.id, "Очень длинное название технологии из вакансии"))).toBeLessThanOrEqual(64);
    expect(resolveSkill(store, user.id, cb.key, cb.has)).toBe("Kafka");
    expect(store.getProfile(user.id)!.verified_skills).toEqual(["Go", "Kafka"]);
    expect(threadWaiting(store, user.id, 11)).toBe(false);
    expect(resolveSkill(store, user.id, cb.key, cb.has)).toBeNull(); // double tap is a no-op

    askSkill(store, user.id, 13, "ClickHouse");
    const no = parseSkillCallback(skillCallback(false, user.id, "ClickHouse"))!;
    resolveSkill(store, user.id, no.key, no.has);
    expect(store.getProfile(user.id)!.never_claim_skills).toEqual(["ClickHouse"]);
    // A later profile.yaml import keeps the Telegram answers.
    const reimported = withLearnedSkills({ ...defaultProfile(), verified_skills: ["Go"], never_claim_skills: [] }, learnedSkills(store, user.id));
    expect(reimported.verified_skills).toEqual(["Go", "Kafka"]);
    expect(reimported.never_claim_skills).toEqual(["ClickHouse"]);
  });
});
