// Guard-rails for LLM-tailored CVs: facts (jobs, education, identity) must survive tailoring untouched,
// never_claim skills must not appear, and sizes must stay one-page friendly.
import type { CV } from "@sgz/shared";
import { claimRegex } from "../llm/guards.js";

const MAX_BULLET_CHARS = 220;
const MAX_ABOUT_CHARS = 900;

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function diffSets(base: string[], tailored: string[]): { missing: string[]; added: string[] } {
  const b = new Set(base);
  const t = new Set(tailored);
  return { missing: base.filter((x) => !t.has(x)), added: tailored.filter((x) => !b.has(x)) };
}

/** Every text field of the CV with a human-readable path, for token scans. */
function cvTextFields(cv: CV): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [{ path: "title", text: cv.title }, { path: "about", text: cv.about }];
  cv.skills.forEach((g, i) => {
    out.push({ path: `skills[${i}].name`, text: g.name });
    g.items.forEach((it, j) => out.push({ path: `skills[${i}].items[${j}]`, text: it }));
  });
  cv.jobs.forEach((j, i) => {
    out.push({ path: `jobs[${i}].role`, text: j.role }, { path: `jobs[${i}].summary`, text: j.summary });
    j.bullets.forEach((b, k) => out.push({ path: `jobs[${i}].bullets[${k}]`, text: b }));
    j.stack.forEach((s, k) => out.push({ path: `jobs[${i}].stack[${k}]`, text: s }));
  });
  cv.education.forEach((e, i) => {
    out.push({ path: `education[${i}].degree`, text: e.degree }, { path: `education[${i}].note`, text: e.note });
  });
  return out;
}

export function validateCV(base: CV, tailored: CV, neverClaim: string[]): string[] {
  const v: string[] = [];

  const jobKey = (j: CV["jobs"][number]) => `${norm(j.company)} | ${norm(j.period)}`;
  const jobs = diffSets(base.jobs.map(jobKey), tailored.jobs.map(jobKey));
  for (const m of jobs.missing) v.push(`job removed or changed: ${m}`);
  for (const a of jobs.added) v.push(`job added or changed: ${a}`);

  const eduKey = (e: CV["education"][number]) => `${norm(e.institution)} | ${norm(e.degree)} | ${norm(e.period)}`;
  const edu = diffSets(base.education.map(eduKey), tailored.education.map(eduKey));
  for (const m of edu.missing) v.push(`education removed or changed: ${m}`);
  for (const a of edu.added) v.push(`education added or changed: ${a}`);

  if (norm(base.name) !== norm(tailored.name)) v.push(`name changed: «${base.name}» → «${tailored.name}»`);
  for (const key of Object.keys(base.contacts) as (keyof CV["contacts"])[]) {
    if (norm(base.contacts[key]) !== norm(tailored.contacts[key])) {
      v.push(`contacts.${key} changed: «${base.contacts[key]}» → «${tailored.contacts[key]}»`);
    }
  }

  const terms = neverClaim.map((t) => t.trim()).filter(Boolean);
  if (terms.length) {
    const fields = cvTextFields(tailored);
    for (const term of terms) {
      const re = claimRegex([term])!; // Unicode-aware boundaries: "Go" does not match "Google"
      for (const f of fields) if (re.test(f.text)) v.push(`never_claim «${term}» found in ${f.path}`);
    }
  }

  tailored.jobs.forEach((j, i) =>
    j.bullets.forEach((b, k) => {
      if (b.length > MAX_BULLET_CHARS) v.push(`jobs[${i}].bullets[${k}] is ${b.length} chars (max ${MAX_BULLET_CHARS})`);
    }),
  );
  if (tailored.about.length > MAX_ABOUT_CHARS) v.push(`about is ${tailored.about.length} chars (max ${MAX_ABOUT_CHARS})`);
  if (!tailored.title.trim()) v.push("title is empty");
  return v;
}
