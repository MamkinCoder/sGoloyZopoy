import { describe, expect, it } from "vitest";
import { defaultProfile } from "../config/profile.js";
import { openStore, seedDefaultUsers } from "../db/index.js";
import { knownSkill, learnedSkills, learnSkill, legacySkillName, parseSkillCallback, withLearnedSkills } from "./skills.js";

describe("skill answers", () => {
  it("moves a skill between the lists and keeps the answers for a later profile.yaml import", () => {
    const store = openStore(":memory:");
    seedDefaultUsers(store);
    const user = store.listUsers(true)[0]!;
    store.saveProfile(user.id, { ...defaultProfile(), verified_skills: ["Go"], never_claim_skills: [] });

    learnSkill(store, user.id, "Kafka", true);
    expect(store.getProfile(user.id)!.verified_skills).toEqual(["Go", "Kafka"]);
    learnSkill(store, user.id, "ClickHouse", false);
    expect(store.getProfile(user.id)!.never_claim_skills).toEqual(["ClickHouse"]);
    expect(knownSkill(store.getProfile(user.id)!, "kafka")).toBe("yes");
    expect(knownSkill(store.getProfile(user.id)!, "clickhouse")).toBe("no");
    expect(knownSkill(store.getProfile(user.id)!, "Vitest")).toBeNull();

    const reimported = withLearnedSkills({ ...defaultProfile(), verified_skills: ["Go"], never_claim_skills: [] }, learnedSkills(store, user.id));
    expect(reimported.verified_skills).toEqual(["Go", "Kafka"]);
    expect(reimported.never_claim_skills).toEqual(["ClickHouse"]);
  });

  it("reads the skill of an old one-skill card once", () => {
    const store = openStore(":memory:");
    store.setSetting("skill_pending:1:kafka", "Kafka");
    expect(parseSkillCallback("sk:y:1:kafka")).toEqual({ has: true, userId: 1, key: "kafka" });
    expect(legacySkillName(store, 1, "kafka", true)).toBe("Kafka");
    expect(legacySkillName(store, 1, "kafka", true)).toBeNull();
  });
});
