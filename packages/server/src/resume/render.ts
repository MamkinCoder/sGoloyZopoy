// CV → ReadableCV LaTeX source. The skeleton lives in template.tex (same preamble as the author's
// hand-written resumes); this module fills the {{slots}} with escaped text using the macro
// signatures from ReadableCV.cls (data/tex, user-customised copy):
//   \newRole{dates}{job title}{company}{bold text under the dates}   → location goes into #4
//   \roleResponsibilities{responsibilities}{achievements}{free}{free}{technologies}
//   \setYourMobileNo / \setYourEmailAddr / \setYourTgAddr / \setYourWebAddr (globe icon → GitHub)
//   \setImage{file}   (header with photo; that variant prints no Telegram line, so it moves to «О себе»)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CV } from "@sgz/shared";
import { escapeLatex } from "./escape.js";
import type { CVDoc } from "./yaml.js";

const CONTACT_MACROS: Record<keyof CV["contacts"], string | null> = {
  phone: "setYourMobileNo",
  email: "setYourEmailAddr",
  telegram: "setYourTgAddr",
  github: "setYourWebAddr",
  city: null, // the class has no location field; rendered as a line under «О себе»
};

const CONTACT_LABELS: Partial<Record<keyof CV["contacts"], string>> = { city: "Город", telegram: "Telegram" };

function templatePath(): string {
  // tsc does not copy .tex into dist/, so a built server falls back to the source tree
  const candidates = [new URL("./template.tex", import.meta.url), new URL("../../src/resume/template.tex", import.meta.url)];
  for (const c of candidates) {
    const p = fileURLToPath(c);
    if (existsSync(p)) return p;
  }
  throw new Error("resume/template.tex not found next to render.js or in src/resume");
}

function loadTemplate(): string {
  return readFileSync(templatePath(), "utf8");
}

const esc = (s: string): string => escapeLatex(s.replace(/\s*\n\s*/g, " ").trim());

/** Which contacts get a header macro vs. a text line: the photo header has no Telegram slot. */
function contactPlacement(cv: CVDoc): { macro: (keyof CV["contacts"])[]; text: (keyof CV["contacts"])[] } {
  const keys = Object.keys(CONTACT_MACROS) as (keyof CV["contacts"])[];
  const macro = keys.filter((k) => CONTACT_MACROS[k] !== null && !(cv.photo && k === "telegram"));
  const text = keys.filter((k) => !macro.includes(k));
  return { macro, text };
}

function renderContacts(cv: CVDoc): string {
  return contactPlacement(cv)
    .macro.filter((k) => cv.contacts[k].trim())
    .map((k) => `\\${CONTACT_MACROS[k]}{${esc(cv.contacts[k])}}`)
    .join("\n");
}

function renderAbout(cv: CVDoc): string {
  const parts = cv.about
    .split(/\n\s*\n/)
    .map(esc)
    .filter(Boolean);
  const extra = contactPlacement(cv)
    .text.filter((k) => cv.contacts[k].trim())
    .map((k) => `\\textbf{${CONTACT_LABELS[k] ?? k}:} ${esc(cv.contacts[k])}`);
  if (extra.length) parts.push(extra.join(" \\\\\n"));
  return parts.join("\n\n");
}

function renderSkills(cv: CV): string {
  return cv.skills
    .filter((g) => g.items.length > 0 || g.name.trim())
    .map((g) => `\\textbf{${esc(g.name)}:} ${g.items.map(esc).join(", ")}`)
    .join(" \\\\\n");
}

function renderBullets(bullets: string[]): string {
  const items = bullets.map(esc).filter(Boolean);
  if (items.length === 0) return "";
  // compact list without extra packages: the class already adds 6pt \parskip, so reset it inside the list
  return ["\\begin{itemize}\\setlength{\\itemsep}{0pt}\\setlength{\\parskip}{0pt}", ...items.map((b) => `  \\item ${b}`), "\\end{itemize}"].join("\n");
}

function renderJob(job: CV["jobs"][number]): string {
  return [
    `% ${job.company.replace(/\n/g, " ")}`,
    `\\newRole{${esc(job.period)}}{${esc(job.role)}}{${esc(job.company)}}{${esc(job.location)}}`,
    "\\roleResponsibilities",
    `{${esc(job.summary)}}`,
    `{${renderBullets(job.bullets)}}`,
    "{}{}",
    `{${job.stack.map(esc).join(", ")}}`,
  ].join("\n");
}

function renderEducation(cv: CV): string {
  return cv.education
    .map((e) => {
      let line = esc(e.institution);
      if (e.degree.trim()) line += ` --- ${esc(e.degree)}`;
      if (e.period.trim()) line += `, ${esc(e.period)}`;
      if (e.note.trim()) line += ` (${esc(e.note)})`;
      return line;
    })
    .filter((l) => l.trim())
    .join("\n\n");
}

export function renderTex(cv: CVDoc): string {
  const slots: Record<string, string> = {
    photo: (cv.photo ?? "").trim(), // a file name inside texDir, e.g. "pic.jpg"; not escaped on purpose
    name: esc(cv.name),
    title: esc(cv.title),
    contacts: renderContacts(cv),
    about: renderAbout(cv),
    skills: renderSkills(cv),
    jobs: cv.jobs.map(renderJob).join("\n\n"),
    education: renderEducation(cv),
  };
  let out = loadTemplate();
  // {{#key}}...{{/key}} blocks survive only when the slot is non-empty
  out = out.replace(/\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g, (_m, key: string, inner: string) =>
    (slots[key] ?? "") ? inner : "",
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => slots[key] ?? "");
  return out.replace(/\n{3,}/g, "\n\n");
}
