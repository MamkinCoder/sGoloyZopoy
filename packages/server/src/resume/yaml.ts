import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import type { CV } from "@sgz/shared";

/** CV plus renderer-only extras the frozen model lacks: `photo` = image file inside texDir (\setImage). */
export type CVDoc = CV & { photo?: string };

export const emptyCV = (): CVDoc => ({
  title: "",
  name: "",
  contacts: { email: "", phone: "", telegram: "", github: "", city: "" },
  about: "",
  skills: [],
  jobs: [],
  education: [],
});

const str = (v: unknown): string => (v == null ? "" : typeof v === "string" ? v : String(v));
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s) => s.trim() !== "") : str(v) === "" ? [] : [str(v)];
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const objList = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);

/** Coerce arbitrary parsed YAML/JSON into a full CV: every field present, missing ones empty. */
export function normalizeCV(raw: unknown): CVDoc {
  const r = obj(raw);
  const c = obj(r.contacts);
  const photo = str(r.photo).trim();
  return {
    ...(photo ? { photo } : {}),
    title: str(r.title),
    name: str(r.name),
    contacts: {
      email: str(c.email),
      phone: str(c.phone),
      telegram: str(c.telegram),
      github: str(c.github),
      city: str(c.city),
    },
    about: str(r.about),
    skills: objList(r.skills).map((g) => ({ name: str(g.name), items: strList(g.items) })),
    jobs: objList(r.jobs).map((j) => ({
      company: str(j.company),
      role: str(j.role),
      period: str(j.period),
      location: str(j.location),
      summary: str(j.summary),
      bullets: strList(j.bullets),
      stack: strList(j.stack),
    })),
    education: objList(r.education).map((e) => ({
      institution: str(e.institution),
      degree: str(e.degree),
      period: str(e.period),
      note: str(e.note),
    })),
  };
}

export function loadCV(path: string): CVDoc {
  return normalizeCV(parse(readFileSync(path, "utf8")));
}

export function saveCV(path: string, cv: CVDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  // lineWidth 0: never fold long bullets — one bullet per line keeps diffs and LLM edits readable
  writeFileSync(path, stringify(normalizeCV(cv), { lineWidth: 0 }), "utf8");
}
