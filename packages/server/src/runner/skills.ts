// The seeker's yes/no skill answers. An employer asks about a skill the profile doesn't list: the chat reply
// task waits for a ✅/❌ tap on its Telegram card (src/agent/chats/review.ts). «есть» adds the skill to
// verified_skills, «нет» to never_claim_skills, and both are kept in `skills_learned:<user>` so a profile.yaml
// re-import (deploy) keeps them.
import type { Profile, Store } from "@sgz/shared";

/** Short, callback-safe key (Telegram callback_data is capped at 64 bytes). */
export const skillKey = (skill: string): string =>
  skill.trim().toLowerCase().replace(/[^a-z0-9а-яё+#.]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 24);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What the stored profile (with the learned answers applied) already says about a skill; null = unknown. */
export function knownSkill(p: Pick<Profile, "verified_skills" | "never_claim_skills">, skill: string): "yes" | "no" | null {
  if (p.never_claim_skills.some((s) => same(s, skill))) return "no";
  if (p.verified_skills.some((s) => same(s, skill))) return "yes";
  return null;
}

/** Applies the human's answer to the stored profile and remembers it for later profile.yaml imports. */
export function learnSkill(store: Pick<Store, "getProfile" | "saveProfile" | "getSetting" | "setSetting">, userId: number, skill: string, has: boolean): void {
  const p = store.getProfile(userId);
  if (!p) return;
  const without = (list: string[]) => list.filter((s) => !same(s, skill));
  store.saveProfile(userId, {
    ...p,
    verified_skills: has ? [...without(p.verified_skills), skill] : without(p.verified_skills),
    never_claim_skills: has ? without(p.never_claim_skills) : [...without(p.never_claim_skills), skill],
  });
  const learned = learnedSkills(store, userId);
  learned[has ? "yes" : "no"] = [...without(learned[has ? "yes" : "no"]), skill];
  learned[has ? "no" : "yes"] = without(learned[has ? "no" : "yes"]);
  store.setSetting(learnedKey(userId), JSON.stringify(learned));
}

const learnedKey = (userId: number) => `skills_learned:${userId}`;

export function learnedSkills(store: Pick<Store, "getSetting">, userId: number): { yes: string[]; no: string[] } {
  try {
    const v = JSON.parse(store.getSetting(learnedKey(userId)) || "{}") as { yes?: string[]; no?: string[] };
    return { yes: v.yes ?? [], no: v.no ?? [] };
  } catch {
    return { yes: [], no: [] };
  }
}

/** Profile from profile.yaml plus every skill answered in Telegram (✅ -> verified, ❌ -> never_claim). */
export function withLearnedSkills<P extends { verified_skills: string[]; never_claim_skills: string[] }>(p: P, learned: { yes: string[]; no: string[] }): P {
  const has = (list: string[], s: string) => list.some((x) => same(x, s));
  return {
    ...p,
    verified_skills: [...p.verified_skills.filter((s) => !has(learned.no, s)), ...learned.yes.filter((s) => !has(p.verified_skills, s))],
    never_claim_skills: [...p.never_claim_skills, ...learned.no.filter((s) => !has(p.never_claim_skills, s))],
  };
}

// ---- legacy one-skill cards (`sk:y:<user>:<key>`), sent before the grouped card existed. They may still sit in
// the Telegram chat: a tap resolves that topic on the user's open reply tasks (see agent/chats/review.ts).

export function parseSkillCallback(data: string): { has: boolean; userId: number; key: string } | null {
  const m = /^sk:([yn]):(\d+):(.+)$/.exec(data);
  return m ? { has: m[1] === "y", userId: Number(m[2]), key: m[3]! } : null;
}

/** The skill name an old card asked about (kept in `skill_pending:<user>:<key>`), or null once answered. */
export function legacySkillName(store: Pick<Store, "getSetting" | "setSetting">, userId: number, key: string, consume: boolean): string | null {
  const k = `skill_pending:${userId}:${key}`;
  const name = store.getSetting(k) || null;
  if (name && consume) store.setSetting(k, "");
  return name;
}
