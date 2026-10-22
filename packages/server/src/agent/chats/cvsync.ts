// `cv.sync` (browser job, started by /cvsync in the personal chat): puts the user's CONFIRMED skills (profile.verified_skills,
// the KB statuses) on the Habr Career profile and on every hh.ru resume, and takes the skills she denied off them.
// Additive on purpose: a skill on a resume that is neither confirmed nor denied stays, so a hand-written resume keeps
// its own words. Habr: dictionary titles, at most 30. hh: one LLM call decides which new skills fit which resume's direction.
import { existsSync } from "node:fs";
import { errMessage, notifierFor, paths, tagKey, type HHResume } from "@sgz/shared";
import { getJson } from "../../career/http.js";
import { MAX_SKILLS, readHabrSkills, resolveHabrSkills, writeHabrSkills } from "../../habr/resume.js";
import { claimRegex } from "../../llm/guards.js";
import { renderPrompt } from "../../llm/template.js";
import { userById, type ChatEnv } from "./env.js";

const HH_MAX_SKILLS = 30;
const HH_MAX_EDITS = 10;
const SCHEMA = '```json\n[{ "id": string, "add": string[] }]\n```';

const uniq = (list: string[]): string[] => {
  const seen = new Set<string>();
  return list.filter((s) => s.trim() && !seen.has(tagKey(s)) && (seen.add(tagKey(s)), true));
};
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.some((y) => tagKey(x) === tagKey(y)));
const delta = (before: string[], after: string[]): string => {
  const add = after.filter((x) => !before.some((y) => tagKey(x) === tagKey(y)));
  const del = before.filter((x) => !after.some((y) => tagKey(x) === tagKey(y)));
  return [add.length && `+${add.join(", +")}`, del.length && `−${del.join(", −")}`].filter(Boolean).join("; ");
};

export async function cvSyncJob(env: ChatEnv, userId: number): Promise<void> {
  const user = userById(env.store, userId);
  const profile = user && env.store.getProfile(userId);
  if (!user || !profile) return;
  const verified = uniq(profile.verified_skills);
  const never = claimRegex(profile.never_claim_skills);
  const lines: string[] = [];

  if (env.habr && existsSync(paths.habrCookies(env.cfg, user.slug))) {
    try {
      const s = await env.browser.openHabr(user);
      const current = await readHabrSkills(s);
      const mapped = await resolveHabrSkills(verified, (u) => getJson(u));
      const keep = current.filter((t) => !never?.test(t));
      const next = uniq([...mapped.skills, ...keep]).slice(0, MAX_SKILLS);
      if (same(current, next)) lines.push("Хабр Карьера: навыки уже актуальны");
      else {
        const r = await writeHabrSkills(s, next);
        lines.push(`Хабр Карьера: ${delta(current, next)}${r.missing.length ? `. Нет в словаре Хабра: ${r.missing.join(", ")}` : ""}`);
      }
      if (mapped.missing.length) lines.push(`Хабр: нет в словаре и не добавлено: ${mapped.missing.join(", ")}`);
    } catch (e) {
      lines.push(`Хабр Карьера: не получилось (${errMessage(e)})`);
    }
  }

  const pool = env.store.listHHResumes(userId);
  if (pool.length) {
    try {
      const s = await env.browser.openHH(user);
      const current = new Map<string, string[]>();
      for (const r of pool.slice(0, HH_MAX_EDITS)) {
        current.set(r.hhResumeId, await env.hh.readResumeSkills(s, r.hhResumeId));
        await env.throttle.afterRead();
      }
      const lacking = [...current.values()].some((c) => verified.some((v) => !c.some((x) => tagKey(x) === tagKey(v))));
      const plan = new Map<string, string[]>();
      if (lacking) {
        const resumes = pool.filter((r) => current.has(r.hhResumeId)).map((r) => ({ id: r.hhResumeId, title: r.title, direction: r.direction, skills: current.get(r.hhResumeId) }));
        const raw = await env.llm.json<{ id: string; add: string[] }[]>("cv_sync_assign", "tailor", renderPrompt("cv_sync_assign", { verified: verified.join(", "), resumes: JSON.stringify(resumes, null, 1) }), SCHEMA);
        for (const x of Array.isArray(raw) ? raw : []) plan.set(String(x.id), (x.add ?? []).filter((a) => verified.some((v) => tagKey(v) === tagKey(a))).slice(0, 8));
      }
      for (const r of pool.filter((x) => current.has(x.hhResumeId))) {
        const before = current.get(r.hhResumeId)!;
        const after = uniq([...before.filter((t) => !never?.test(t)), ...(plan.get(r.hhResumeId) ?? [])]).slice(0, HH_MAX_SKILLS);
        if (same(before, after)) continue;
        await env.hh.setResumeSkills(s, r.hhResumeId, after);
        keepSummary(env, r, after);
        lines.push(`hh.ru «${r.title}»: ${delta(before, after)}`);
        await env.throttle.afterMutation();
      }
      if (!lines.some((l) => l.startsWith("hh.ru"))) lines.push("hh.ru: резюме уже актуальны");
    } catch (e) {
      lines.push(`hh.ru: не получилось (${errMessage(e)})`);
    }
  }

  if (!lines.length) lines.push("Нечего обновлять: ни Хабр Карьера, ни резюме hh.ru не подключены (/onboard).");
  await notifierFor(env.notifier, user, "dm").alert("Резюме обновлены по твоим навыкам", lines.join("\n")).catch(() => undefined);
}

/** The stored summary follows the resume so the next decision matches it (first 12 skills, like summarizeResume). */
function keepSummary(env: ChatEnv, r: HHResume, skills: string[]): void {
  if (r.summary) env.store.upsertHHResume({ ...r, summary: { ...r.summary, key_skills: skills.slice(0, 12) } });
}
