// data/users/<slug>/profile.yaml <-> Profile. Missing fields get defaults so the LLM prompt is always complete.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import type { Profile } from "@sgz/shared";

export function defaultProfile(): Profile {
  return {
    full_name: "",
    email: "",
    phone: "",
    telegram: "",
    city: "",
    citizenship: "",
    relocation: "",
    work_formats: [],
    salary_from: 0,
    salary_to: 0,
    currency: "RUR",
    experience: "",
    languages: [],
    directions: [],
    summary: "",
    verified_skills: [],
    never_claim_skills: [],
    hh_queries: [],
    hh_area: "",
    exclude_words: [],
    company_blacklist: [],
    extra: {},
  };
}

const asString = (v: unknown, d: string): string => (v === undefined || v === null ? d : String(v).trim());
const asNumber = (v: unknown, d: number): number => {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const asList = (v: unknown, d: string[]): string[] => {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map((x) => String(x).trim());
  if (typeof v === "string") return v.trim() ? [v.trim()] : d;
  return d;
};
const asStringMap = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined) continue;
    out[k] = String(val).trim();
  }
  return out;
};

/** Coerces an untrusted object (yaml/json) into a full Profile. */
export function normalizeProfile(raw: unknown): Profile {
  const d = defaultProfile();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    full_name: asString(r.full_name, d.full_name),
    email: asString(r.email, d.email),
    phone: asString(r.phone, d.phone),
    telegram: asString(r.telegram, d.telegram),
    city: asString(r.city, d.city),
    citizenship: asString(r.citizenship, d.citizenship),
    relocation: asString(r.relocation, d.relocation),
    work_formats: asList(r.work_formats, d.work_formats),
    salary_from: asNumber(r.salary_from, d.salary_from),
    salary_to: asNumber(r.salary_to, d.salary_to),
    currency: asString(r.currency, d.currency) || d.currency,
    experience: asString(r.experience, d.experience),
    languages: asList(r.languages, d.languages),
    directions: asList(r.directions, d.directions),
    summary: asString(r.summary, d.summary),
    verified_skills: asList(r.verified_skills, d.verified_skills),
    never_claim_skills: asList(r.never_claim_skills, d.never_claim_skills),
    hh_queries: asList(r.hh_queries, d.hh_queries),
    hh_area: asString(r.hh_area, d.hh_area),
    exclude_words: asList(r.exclude_words, d.exclude_words),
    company_blacklist: asList(r.company_blacklist, d.company_blacklist),
    extra: asStringMap(r.extra),
  };
}

export function loadProfileYaml(path: string): Profile {
  return normalizeProfile(parse(readFileSync(path, "utf8")));
}

export function saveProfileYaml(path: string, p: Profile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(normalizeProfile(p)), "utf8");
}
