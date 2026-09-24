// One source of skill claims: kb_tags.status. Every writer (Telegram answer, panel edit, profile.yaml import,
// the 008a fold of the old `skills_learned` setting) moves tags, and syncProfileSkills alone writes the lists.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Profile, Store } from "@sgz/shared";
import { kbReviewGate } from "../agent/chats/review.js";
import { defaultProfile } from "../config/profile.js";
import { openStore } from "../db/index.js";
import { seedDefaultUsers } from "../db/users.js";
import { applyProfileSkills, importProfile, syncProfileSkills } from "./write.js";

const setup = () => {
  const store = openStore(":memory:");
  seedDefaultUsers(store);
  return { store, uid: store.getUserBySlug("yaroslav")!.id };
};
const status = (store: Store, uid: number) => Object.fromEntries(store.listKbTags(uid).map((t) => [t.name, t.status]));
const profile = (verified: string[], never: string[]): Profile => ({ ...defaultProfile(), verified_skills: verified, never_claim_skills: never });

/** No skill is both claimable and never-claimed, and every listed skill is a tag with the matching status. */
function consistent(store: Store, uid: number) {
  const p = store.getProfile(uid)!;
  const tags = store.listKbTags(uid);
  expect(p.verified_skills.filter((s) => p.never_claim_skills.some((n) => n.toLowerCase() === s.toLowerCase()))).toEqual([]);
  for (const s of p.verified_skills) expect(tags.find((t) => t.name.toLowerCase() === s.toLowerCase())?.status).toBe("yes");
  for (const s of p.never_claim_skills) expect(tags.find((t) => t.name.toLowerCase() === s.toLowerCase())?.status).toBe("no");
}

describe("skill claims: kb_tags.status is the only source", () => {
  it("migration 008a folds skills_learned into unknown or missing tags, a KB answer wins, the settings go", () => {
    const { store, uid } = setup();
    store.upsertKbTag(uid, { name: "Kafka" }); // unknown -> takes the old answer
    store.upsertKbTag(uid, { name: "Go", aliases: ["golang"] }); // matched by alias
    store.upsertKbTag(uid, { name: "Rust", status: "yes" }); // answered in the KB later: wins
    store.setSetting(`skills_learned:${uid}`, JSON.stringify({ yes: ["Kafka", "Golang", "Vitest"], no: ["Rust", "ClickHouse"] }));
    store.setSetting("skills_learned:999", JSON.stringify({ yes: ["Ghost"] })); // no such user
    store.setSetting(`skill_pending:${uid}:x`, "X");
    store.setSetting("skills_learned:1000", "not json");
    store.db.exec(readFileSync(fileURLToPath(new URL("../db/migrations/008a_skills_learned_to_kb.sql", import.meta.url)), "utf8"));
    expect(status(store, uid)).toEqual({ ClickHouse: "no", Go: "yes", Kafka: "yes", Rust: "yes", Vitest: "yes" });
    expect([store.getSetting(`skills_learned:${uid}`), store.getSetting(`skill_pending:${uid}:x`), store.getSetting("skills_learned:1000")]).toEqual([null, null, null]);
  });

  it("a Telegram answer moves the tag and the profile lists, and writes no second copy", () => {
    const { store, uid } = setup();
    store.saveProfile(uid, profile(["Go", "Kafka"], []));
    const gate = kbReviewGate(store, { alert: async () => undefined });
    gate.record(uid, "Kafka", false);
    gate.record(uid, "Vitest", true);
    expect(status(store, uid)).toMatchObject({ Kafka: "no", Vitest: "yes" });
    expect(store.getProfile(uid)).toMatchObject({ verified_skills: ["Go", "Vitest"], never_claim_skills: ["Kafka"] });
    expect(store.getSetting(`skills_learned:${uid}`)).toBeNull();
  });

  it("a panel edit becomes tag statuses (new skills get a tag), then one sync writes the lists", () => {
    const { store, uid } = setup();
    store.saveProfile(uid, profile(["Go"], ["Kafka"]));
    store.upsertKbTag(uid, { name: "Go", status: "yes" });
    store.upsertKbTag(uid, { name: "Kafka", status: "no" });
    const edit = profile(["Go", "Kafka", "Redis"], ["PHP"]);
    applyProfileSkills(store, uid, edit);
    store.saveProfile(uid, edit);
    syncProfileSkills(store, uid);
    expect(status(store, uid)).toEqual({ Go: "yes", Kafka: "yes", PHP: "no", Redis: "yes" });
    consistent(store, uid);
    expect(syncProfileSkills(store, uid)).toBe(false); // a later sync keeps the edit
  });

  it("import-profile: profile.yaml seeds only unanswered tags, a human answer wins, the lists agree with the KB", () => {
    const { store, uid } = setup();
    store.upsertKbTag(uid, { name: "Kafka", status: "no" }); // «Нет навыка» in Telegram
    store.upsertKbTag(uid, { name: "Vitest", status: "yes" }); // «Подтвердить»
    store.upsertKbTag(uid, { name: "Redis" }); // seeded, nobody answered
    importProfile(store, uid, profile(["Go", "Kafka", "Redis", "Docker"], ["Vitest", "PHP", "Docker"]));
    expect(status(store, uid)).toEqual({ Docker: "no", Go: "yes", Kafka: "no", PHP: "no", Redis: "yes", Vitest: "yes" });
    expect(store.getProfile(uid)).toMatchObject({ verified_skills: ["Go", "Redis", "Vitest"], never_claim_skills: ["PHP", "Docker", "Kafka"] });
    consistent(store, uid);
    // A re-import (every deploy) changes nothing.
    importProfile(store, uid, profile(["Go", "Kafka", "Redis", "Docker"], ["Vitest", "PHP", "Docker"]));
    expect(status(store, uid)).toEqual({ Docker: "no", Go: "yes", Kafka: "no", PHP: "no", Redis: "yes", Vitest: "yes" });
    consistent(store, uid);
  });
});
