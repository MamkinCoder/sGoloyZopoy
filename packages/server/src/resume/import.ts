// One-time import of a hand-written ReadableCV .tex into the CV model.
//
// Best-effort: it understands exactly the macro shapes used in the author's two original resumes
// (see test/resume/sample-*.tex) and nothing more:
//   \setYourName{} \setYourJobTitle{} \setYourMobileNo{} \setYourEmailAddr{} \setYourTgAddr{}
//   \setYourWebAddr{} → contacts.github, \setImage{} → photo
//   \newHeading{О себе | Технический стек | Опыт работы | Образование}
//   skills:    \textbf{Group:} a, b, c \\
//   jobs:      \newRole{period}{role}{company}{location}
//              \roleResponsibilities{summary}{- bullet\n- bullet}{}{}{stack, tags}
//              (the class takes 5 args; the hand-written files pass 6 — the last group is the stack
//              either way; bullets may also be a \begin{itemize} \item ... \end{itemize} block)
//   education: "Institution — Degree, 2019–2022 (note)" one entry per paragraph
// Everything else produces a warning and is dropped. Inline formatting (\uline, \textbf) is flattened
// to plain text — the model has no place for it.
import type { CV } from "@sgz/shared";
import { emptyCV, type CVDoc } from "./yaml.js";

export interface ImportResult {
  cv: CVDoc;
  warnings: string[];
}

type Job = CV["jobs"][number];

const HEADER_MACROS: Record<string, "name" | "title" | "photo" | `contacts.${keyof CV["contacts"]}`> = {
  setYourName: "name",
  setYourJobTitle: "title",
  setYourMobileNo: "contacts.phone",
  setYourHomeNo: "contacts.phone",
  setYourEmailAddr: "contacts.email",
  setYourTgAddr: "contacts.telegram",
  setYourWebAddr: "contacts.github",
  setImage: "photo",
};

/** Layout / preamble macros we deliberately ignore, with the number of brace args to skip. */
const IGNORED_MACROS: Record<string, number> = {
  documentclass: 1,
  usepackage: 1,
  makeatletter: 0,
  makeatother: 0,
  "@ifundefined": 3,
  let: 0,
  ordinal: 0,
  relax: 0,
  color: 1,
  begin: 1,
  end: 1,
  setPageColour: 1,
  setPageColor: 1,
  setHeaderAlignment: 1,
  setHeadingColours: 1,
  setHeadingColors: 1,
  setContactLocation: 1,
  setSectionAlignment: 1,
  setJobCompanyOrder: 1,
  showHeader: 0,
};

const SECTION_BY_HEADING: Record<string, "about" | "skills" | "jobs" | "education"> = {
  "о себе": "about",
  "обо мне": "about",
  "технический стек": "skills",
  "стек": "skills",
  "навыки": "skills",
  "опыт работы": "jobs",
  "опыт": "jobs",
  "образование": "education",
};

export function importTex(tex: string): ImportResult {
  const warnings: string[] = [];
  const cv = emptyCV();
  const src = stripComments(tex.replace(/\r\n?/g, "\n"));
  const body = documentBody(src);

  const segments = splitByHeadings(body);
  parseHeader(segments.header, cv, warnings);

  for (const seg of segments.sections) {
    const kind = SECTION_BY_HEADING[seg.heading.trim().toLowerCase()];
    if (!kind) {
      warnings.push(`unknown section «${seg.heading}» skipped`);
      continue;
    }
    if (kind === "about") cv.about = parseAbout(seg.body, warnings);
    else if (kind === "skills") cv.skills = parseSkills(seg.body, warnings);
    else if (kind === "jobs") cv.jobs = parseJobs(seg.body, warnings);
    else cv.education = parseEducation(seg.body, warnings);
  }
  return { cv, warnings };
}

// ---------- text utilities ----------

/** Remove `% ...` comments (not `\%`) line by line. Lines that were only a comment vanish. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === "\\") {
          out += ch + (line[i + 1] ?? "");
          i++;
          continue;
        }
        if (ch === "%") break;
        out += ch;
      }
      return out;
    })
    .join("\n");
}

function documentBody(src: string): string {
  const start = src.indexOf("\\begin{document}");
  const end = src.lastIndexOf("\\end{document}");
  if (start < 0) return src;
  return src.slice(start + "\\begin{document}".length, end < 0 ? undefined : end);
}

/** Read one `{...}` group at `pos` (leading whitespace allowed). Nested braces are balanced. */
function readGroup(src: string, pos: number): { value: string; end: number } | null {
  let i = pos;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { value: src.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

function readGroups(src: string, pos: number, max: number): { values: string[]; end: number } {
  const values: string[] = [];
  let end = pos;
  for (let k = 0; k < max; k++) {
    const g = readGroup(src, end);
    if (!g) break;
    values.push(g.value);
    end = g.end;
  }
  return { values, end };
}

function skipOptional(src: string, pos: number): number {
  const m = /^\s*\[[^\]]*\]/.exec(src.slice(pos));
  return m ? pos + m[0].length : pos;
}

const INLINE_WRAPPERS = /\\(?:uline|textbf|textit|emph|underline|texttt)\{([^{}]*)\}/g;

/** LaTeX text → plain text: strip inline formatting, unescape specials, normalise dashes/spaces. */
function unescapeLatex(s: string): string {
  let t = s;
  for (let guard = 0; guard < 5 && INLINE_WRAPPERS.test(t); guard++) {
    t = t.replace(INLINE_WRAPPERS, "$1");
  }
  t = t
    .replace(/\$\\sim\$/g, "~")
    .replace(/\\textasciitilde(?:\{\})?/g, "~")
    .replace(/\\textasciicircum(?:\{\})?/g, "^")
    .replace(/\\textbackslash(?:\{\})?/g, "\\")
    .replace(/\\,/g, " ")
    .replace(/\\ /g, " ")
    .replace(/\\@/g, "")
    .replace(/(^|[^\\])~/g, "$1 ")
    .replace(/\\([%&_#$\{\}])/g, "$1")
    .replace(/---/g, "\u2014")
    .replace(/--/g, "\u2013")
    .replace(/\{\}/g, "");
  return t;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Everything that still looks like a macro after unescaping → one warning each. */
function warnLeftoverMacros(text: string, where: string, warnings: string[]): void {
  for (const m of text.matchAll(/\\[A-Za-z@]+/g)) warnings.push(`${where}: unrecognised ${m[0]} left in text`);
}

// ---------- structure ----------

function splitByHeadings(body: string): { header: string; sections: { heading: string; body: string }[] } {
  const sections: { heading: string; body: string }[] = [];
  const re = /\\newHeading\s*\{/g;
  let header = "";
  let prev: { heading: string; start: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const g = readGroup(body, m.index + "\\newHeading".length);
    if (!g) break;
    const chunk = body.slice(prev ? prev.start : 0, m.index);
    if (prev) sections.push({ heading: prev.heading, body: chunk });
    else header = chunk;
    prev = { heading: g.value, start: g.end };
    re.lastIndex = g.end;
  }
  const tail = body.slice(prev ? prev.start : 0);
  if (prev) sections.push({ heading: prev.heading, body: tail });
  else header = tail;
  return { header, sections };
}

function setPath(cv: CVDoc, path: string, value: string): void {
  if (path.startsWith("contacts.")) {
    cv.contacts[path.slice("contacts.".length) as keyof CV["contacts"]] = value;
  } else if (path === "photo") {
    if (value) cv.photo = value;
  } else {
    cv[path as "name" | "title"] = value;
  }
}

/** Walk macros in `text`; `onMacro` returns the position to continue from, or null for "not mine". */
function walkMacros(
  text: string,
  where: string,
  warnings: string[],
  onMacro: (name: string, pos: number) => number | null,
): void {
  const re = /\\([A-Za-z@]+|\\)/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(text))) {
    const name = m[1]!;
    const between = text.slice(lastEnd, m.index);
    if (collapse(between) !== "") warnings.push(`${where}: stray text dropped: «${collapse(between).slice(0, 60)}»`);
    if (name === "\\") {
      lastEnd = re.lastIndex;
      continue;
    }
    let next = onMacro(name, re.lastIndex);
    if (next == null) {
      if (name in IGNORED_MACROS) {
        next = readGroups(text, skipOptional(text, re.lastIndex), IGNORED_MACROS[name]!).end;
      } else {
        const g = readGroups(text, re.lastIndex, 10);
        warnings.push(`${where}: unrecognised \\${name} dropped`);
        next = g.end;
      }
    }
    re.lastIndex = next;
    lastEnd = next;
  }
  const rest = text.slice(lastEnd);
  if (collapse(rest) !== "") warnings.push(`${where}: stray text dropped: «${collapse(rest).slice(0, 60)}»`);
}

function parseHeader(text: string, cv: CVDoc, warnings: string[]): void {
  walkMacros(text, "header", warnings, (name, pos) => {
    const field = HEADER_MACROS[name];
    if (!field) return null;
    const g = readGroup(text, pos);
    if (!g) return null;
    setPath(cv, field, collapse(unescapeLatex(g.value)));
    return g.end;
  });
}

function parseAbout(text: string, warnings: string[]): string {
  // the section may carry layout macros (\setSectionAlignment ...); drop those, keep everything else
  const layout = new RegExp(`\\\\(${Object.keys(IGNORED_MACROS).join("|")})(?![A-Za-z@])\\s*(\\{[^}]*\\})*`, "g");
  const paragraphs = text
    .replace(layout, "")
    .split(/\n\s*\n/)
    .map((p) => collapse(unescapeLatex(p)))
    .filter(Boolean);
  const about = paragraphs.join("\n\n");
  warnLeftoverMacros(about, "about", warnings);
  return about;
}

function parseSkills(text: string, warnings: string[]): CV["skills"] {
  const groups: CV["skills"] = [];
  for (const raw of text.split(/\\\\/)) {
    const line = collapse(raw);
    if (!line) continue;
    const bold = /^\\textbf\{([^}]*)\}\s*(.*)$/s.exec(line);
    const plain = bold ? null : /^([^:]{1,60}):\s*(.*)$/s.exec(line);
    const m = bold ?? plain;
    if (!m) {
      warnings.push(`skills: cannot parse line «${line.slice(0, 60)}»`);
      continue;
    }
    const name = collapse(unescapeLatex(m[1]!)).replace(/:$/, "").trim();
    const items = splitList(unescapeLatex(m[2]!));
    warnLeftoverMacros(name + " " + items.join(" "), "skills", warnings);
    groups.push({ name, items });
  }
  return groups;
}

/** Split "a, b (x, y), c" on commas that are not inside parentheses. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(collapse).filter(Boolean);
}

function parseJobs(text: string, warnings: string[]): Job[] {
  const jobs: Job[] = [];
  walkMacros(text, "jobs", warnings, (name, pos) => {
    if (name === "newRole") {
      const { values, end } = readGroups(text, pos, 4);
      const [period = "", role = "", company = "", location = ""] = values.map((v) => collapse(unescapeLatex(v)));
      if (values.length < 3) warnings.push(`jobs: \\newRole with ${values.length} args (expected 4)`);
      jobs.push({ company, role, period, location, summary: "", bullets: [], stack: [] });
      return end;
    }
    if (name === "roleResponsibilities") {
      const { values, end } = readGroups(text, pos, 6);
      const job = jobs.at(-1);
      const where = `jobs[${jobs.length - 1}]`;
      if (!job) {
        warnings.push("jobs: \\roleResponsibilities before any \\newRole dropped");
        return end;
      }
      if (values.length !== 5 && values.length !== 6) warnings.push(`${where}: \\roleResponsibilities with ${values.length} args (expected 5)`);
      const [summary = "", bullets = ""] = values;
      const stack = values.length >= 3 ? values[values.length - 1]! : "";
      for (const [i, extra] of values.slice(2, -1).entries()) {
        if (collapse(extra)) warnings.push(`${where}: \\roleResponsibilities arg ${i + 3} «${collapse(extra).slice(0, 40)}» dropped`);
      }
      job.summary = collapse(unescapeLatex(summary));
      job.bullets = parseBullets(bullets);
      job.stack = splitList(unescapeLatex(stack));
      warnLeftoverMacros([job.summary, ...job.bullets, ...job.stack].join(" "), where, warnings);
      return end;
    }
    return null;
  });
  return jobs;
}

function parseBullets(text: string): string[] {
  const bullets: string[] = [];
  if (/\\item\b/.test(text)) {
    const body = text.replace(/\\(begin|end)\{itemize\}|\\setlength\{[^}]*\}\{[^}]*\}/g, "");
    for (const chunk of body.split(/\\item\b/).slice(1)) bullets.push(chunk);
  } else {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = /^[-•*]\s*(.*)$/.exec(line);
      if (m || bullets.length === 0) bullets.push(m ? m[1]! : line);
      else bullets[bullets.length - 1] += " " + line;
    }
  }
  return bullets.map((b) => collapse(unescapeLatex(b))).filter(Boolean);
}

const EDU_RE = /^(.+?)\s+[—–-]\s+(.+?),\s*(\d{4}\s*[—–-]\s*(?:\d{4}|н\.\s*в\.))\s*(?:\((.*)\))?\s*$/u;

function parseEducation(text: string, warnings: string[]): CV["education"] {
  const out: CV["education"] = [];
  for (const p of text.split(/\n\s*\n/)) {
    const line = collapse(unescapeLatex(p));
    if (!line) continue;
    const m = EDU_RE.exec(line);
    if (m) {
      out.push({ institution: m[1]!, degree: m[2]!, period: m[3]!.replace(/\s*([—–-])\s*/, "$1"), note: m[4] ?? "" });
    } else {
      warnings.push(`education: could not split «${line.slice(0, 60)}»; stored as institution`);
      out.push({ institution: line, degree: "", period: "", note: "" });
    }
    warnLeftoverMacros(line, "education", warnings);
  }
  return out;
}
