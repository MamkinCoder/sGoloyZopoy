// Unknown-skill approvals. When an employer asks about a skill the profile doesn't list, the chat bot
// holds its reply and asks the human in Telegram: «есть» adds it to verified_skills, «нет» to
// never_claim_skills. The next chat poll answers with the updated profile.
import type { Store } from "@sgz/shared";

/** Short, callback-safe key (Telegram callback_data is capped at 64 bytes). */
export const skillKey = (skill: string): string =>
  skill.trim().toLowerCase().replace(/[^a-z0-9а-яё+#.]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 24);

const pendingKey = (userId: number, key: string) => `skill_pending:${userId}:${key}`;
const waitKey = (threadId: number) => `skill_wait:${threadId}`;

/** Registers the question and returns true if it's new (so the caller sends one Telegram prompt). */
export function askSkill(store: Store, userId: number, threadId: number, skill: string): boolean {
  const key = skillKey(skill);
  const waiting = new Set((store.getSetting(waitKey(threadId)) ?? "").split(",").filter(Boolean));
  waiting.add(key);
  store.setSetting(waitKey(threadId), [...waiting].join(","));
  if (store.getSetting(pendingKey(userId, key))) return false;
  store.setSetting(pendingKey(userId, key), skill.trim());
  return true;
}

/** True while any skill this thread asked about is still unanswered in Telegram. */
export function threadWaiting(store: Store, userId: number, threadId: number): boolean {
  const keys = (store.getSetting(waitKey(threadId)) ?? "").split(",").filter(Boolean);
  return keys.some((k) => Boolean(store.getSetting(pendingKey(userId, k))));
}

/** Applies the human's answer to the stored profile. Returns the skill, or null if already handled. */
export function resolveSkill(store: Store, userId: number, key: string, has: boolean): string | null {
  const skill = store.getSetting(pendingKey(userId, key));
  const p = skill ? store.getProfile(userId) : null;
  if (!skill || !p) return null;
  const without = (list: string[]) => list.filter((s) => s.toLowerCase() !== skill.toLowerCase());
  store.saveProfile(userId, {
    ...p,
    verified_skills: has ? [...without(p.verified_skills), skill] : without(p.verified_skills),
    never_claim_skills: has ? without(p.never_claim_skills) : [...without(p.never_claim_skills), skill],
  });
  store.setSetting(pendingKey(userId, key), "");
  // profile.yaml is re-imported on deploys: keep the human's answers separately and re-apply them then.
  const learned = learnedSkills(store, userId);
  learned[has ? "yes" : "no"] = [...new Set([...learned[has ? "yes" : "no"], skill])];
  learned[has ? "no" : "yes"] = learned[has ? "no" : "yes"].filter((s) => s.toLowerCase() !== skill.toLowerCase());
  store.setSetting(learnedKey(userId), JSON.stringify(learned));
  return skill;
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
  const has = (list: string[], s: string) => list.some((x) => x.toLowerCase() === s.toLowerCase());
  const no = learned.no.map((s) => s.toLowerCase());
  return {
    ...p,
    verified_skills: [...p.verified_skills.filter((s) => !no.includes(s.toLowerCase())), ...learned.yes.filter((s) => !has(p.verified_skills, s))],
    never_claim_skills: [...p.never_claim_skills, ...learned.no.filter((s) => !has(p.never_claim_skills, s))],
  };
}

export const skillCallback = (has: boolean, userId: number, skill: string): string => `sk:${has ? "y" : "n"}:${userId}:${skillKey(skill)}`;

export function parseSkillCallback(data: string): { has: boolean; userId: number; key: string } | null {
  const m = /^sk:([yn]):(\d+):(.+)$/.exec(data);
  return m ? { has: m[1] === "y", userId: Number(m[2]), key: m[3]! } : null;
}
