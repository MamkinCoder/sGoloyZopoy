// Post-checks for tailor_cv: the model may reorder and rephrase; it may not change facts.
import type { CV, Profile } from "@sgz/shared";
import { LIMITS, blockedTech, claimRegex, enforceMax, normalizeProse, stripNeverClaimSentences } from "./guards.js";

const norm = (s: string) => s.trim().toLowerCase();

function allowedTools(profile: Profile, base: CV): Set<string> {
  const set = new Set<string>();
  for (const s of profile.verified_skills) set.add(norm(s));
  for (const g of base.skills) for (const i of g.items) set.add(norm(i));
  for (const j of base.jobs) for (const s of j.stack) set.add(norm(s));
  return set;
}

export function guardTailoredCV(profile: Profile, base: CV, tailored: CV): { cv: CV; dropped: string[] } {
  const never = profile.never_claim_skills;
  const neverRe = claimRegex(never);
  const allowed = allowedTools(profile, base);
  const dropped: string[] = [];
  const keepTool = (t: string): boolean => {
    const ok = allowed.has(norm(t)) && !(neverRe?.test(t) ?? false);
    if (!ok) dropped.push(t);
    return ok;
  };
  // Prose may mention only tech the seeker verified or the base CV already lists, same as letters.
  const blocked = blockedTech({ verified_skills: [...allowed], never_claim_skills: never });
  const cleanText = (s: string, max: number) => enforceMax(stripNeverClaimSentences(normalizeProse(s), blocked), max);

  const skills = tailored.skills
    .map((g) => ({ name: g.name, items: g.items.filter(keepTool) }))
    .filter((g) => g.items.length > 0);

  // Jobs: base is the source of truth for identity/order; tailored supplies wording.
  const jobs = base.jobs.map((bj) => {
    const tj =
      tailored.jobs.find((j) => norm(j.company) === norm(bj.company) && norm(j.role) === norm(bj.role)) ??
      tailored.jobs.find((j) => norm(j.company) === norm(bj.company));
    if (!tj) return bj;
    const bullets = tj.bullets.map((b) => cleanText(b, LIMITS.bullet)).filter(Boolean);
    return {
      company: bj.company,
      role: bj.role,
      period: bj.period,
      location: bj.location,
      summary: cleanText(tj.summary || bj.summary, 600),
      bullets: bullets.length ? bullets.slice(0, Math.max(bj.bullets.length, 1)) : bj.bullets,
      stack: (tj.stack.length ? tj.stack : bj.stack).filter(keepTool),
    };
  });

  const cv: CV = {
    title: cleanText(tailored.title || base.title, 120),
    name: base.name,
    contacts: base.contacts,
    about: cleanText(tailored.about || base.about, LIMITS.about),
    skills: skills.length ? skills : base.skills,
    jobs,
    education: base.education,
  };
  return { cv, dropped };
}
