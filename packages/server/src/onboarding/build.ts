// Answers (+ optional CV text) → Profile and a base CV. The LLM structures; the guard keeps every skill inside what the
// person said or the CV text contains, so auto-apply and letters never claim more than the facts.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LLMClient, Profile } from "@sgz/shared";
import { defaultProfile } from "../config/profile.js";
import { renderPrompt } from "../llm/index.js";
import { normalizeCV, type CVDoc } from "../resume/yaml.js";

export interface Answers {
  name: string;
  role: string;
  skills: string[];
  years: string;
  salary: string;
  place: string;
}

const SCHEMA = "см. раздел «Схема ответа» в промпте";
const DIRECTIONS = ["go-backend", "node-backend", "python-backend", "java-backend", "react", "vue", "fullstack", "android", "ios", "devops", "data", "qa", "other"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `skill` stands as a word in `hay` (so "Go" does not match "good"). */
export const mentions = (hay: string, skill: string): boolean => new RegExp(`(^|[^\\p{L}\\d+#.])${esc(skill.trim())}($|[^\\p{L}\\d+#])`, "iu").test(hay);

/** «от 200 до 300 тыс» → [200000, 300000]; numbers below 1000 are thousands; nothing parsable → [0, 0]. */
export function parseSalary(text: string): [number, number] {
  const nums = (text.replace(/(\d)[\s ](?=\d{3}\b)/g, "$1").match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(",", ".")) * (Number(n.replace(",", ".")) < 1000 ? 1000 : 1));
  return nums.length ? [Math.min(...nums), nums.length > 1 ? Math.max(...nums) : 0] : [0, 0];
}

export const parseFormats = (place: string): string[] => {
  const f = [/удал|remote/i.test(place) && "remote", /гибрид|hybrid/i.test(place) && "hybrid", /офис|office/i.test(place) && "office"].filter((x): x is string => !!x);
  return f.length ? f : ["remote", "hybrid", "office"];
};

export async function buildProfile(llm: LLMClient, a: Answers, cvText: string): Promise<{ profile: Profile; cv: CVDoc }> {
  const raw = await llm.json<{ summary?: string; experience?: string; directions?: string[]; hh_queries?: string[]; verified_skills?: string[]; cv?: unknown }>(
    "onboard_profile",
    "tailor",
    renderPrompt("onboard_profile", { answers: JSON.stringify(a, null, 2), cv_text: cvText || "(нет)" }),
    SCHEMA,
  );
  const facts = `${a.skills.join(", ")}\n${cvText}`;
  const ok = (s: string) => !!s.trim() && mentions(facts, s);
  const cv = normalizeCV(raw.cv);
  cv.skills = cv.skills.map((g) => ({ ...g, items: g.items.filter(ok) })).filter((g) => g.items.length);
  cv.jobs = cv.jobs.map((j) => ({ ...j, stack: j.stack.filter(ok) }));
  const [from, to] = parseSalary(a.salary);
  const skills = [...new Set([...a.skills, ...(raw.verified_skills ?? []).filter(ok)])];
  const directions = (raw.directions ?? []).filter((d) => DIRECTIONS.includes(d)).slice(0, 3);
  const profile: Profile = {
    ...defaultProfile(),
    full_name: a.name,
    city: a.place,
    work_formats: parseFormats(a.place),
    salary_from: from,
    salary_to: to,
    experience: raw.experience?.trim() || a.years,
    directions: directions.length ? directions : ["other"],
    summary: raw.summary?.trim() ?? "",
    verified_skills: skills,
    hh_queries: (raw.hh_queries ?? []).map((q) => q.trim()).filter(Boolean).slice(0, 8),
    extra: { place: a.place, target_role: a.role },
  };
  if (!profile.hh_queries.length) profile.hh_queries = [a.role.trim()];
  return { profile, cv: { ...cv, name: a.name, contacts: { ...cv.contacts, city: a.place } } };
}

/** Text of a PDF via poppler's pdftotext (apt install poppler-utils on the Pi). */
export async function pdfText(buf: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sgz-cv-"));
  try {
    const file = join(dir, "cv.pdf");
    await writeFile(file, buf);
    const { stdout } = await promisify(execFile)("pdftotext", ["-layout", file, "-"], { maxBuffer: 8 << 20, timeout: 30_000 });
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const summaryText = (p: Profile): string =>
  [
    `Направления: ${p.directions.join(", ")}`,
    `Опыт: ${p.experience || "не указан"}`,
    `Навыки: ${p.verified_skills.join(", ") || "не указаны"}`,
    `Ищу вакансии по запросам: ${p.hh_queries.join("; ")}`,
    `Зарплата: ${p.salary_from ? `от ${p.salary_from}${p.salary_to ? ` до ${p.salary_to}` : ""}` : "не называю"}`,
    `Формат: ${p.work_formats.join(", ")}; ${p.city}`,
  ].join("\n");
