// LaTeX escaping for text that goes into ReadableCV macros / paragraphs.
// Target is pdflatex + [T2A]{fontenc} + [utf8]{inputenc}: Cyrillic and « » pass through, but dashes,
// ellipsis, arrows and spaces outside inputenc's tables are mapped to macros so a stray Unicode
// character never aborts the build.

const SPECIALS: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  "$": "\\$",
  "#": "\\#",
  "_": "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "$\\sim$", // in CV text "~5 минут" means "approximately", so the math tilde reads better than \textasciitilde
  "^": "\\textasciicircum{}",
  "\u00a0": "~", // NBSP → LaTeX tie
  "\u202f": "\\,", // narrow NBSP → thin space
  "\u2013": "--", // en dash
  "\u2014": "---", // em dash
  "\u2026": "\\ldots{}",
  "\u2192": "$\\to$",
  "\u2190": "$\\leftarrow$",
  "\u2248": "$\\approx$",
  "\u2264": "$\\le$",
  "\u2265": "$\\ge$",
  "\u00d7": "$\\times$",
  "\u2022": "\\textbullet{}",
  "\u2018": "`",
  "\u2019": "'",
  "\u201c": "``",
  "\u201d": "''",
};

// Units that get a thin space after a number: "2.0 с" → "2.0\,с". Word-boundary on the right side only.
const UNIT_RE = /(\d)[ \u00a0](с|мс|сек|мин|ч|кб|мб|гб|тб|kb|mb|gb|tb|шт|руб|млн|тыс)(?![\p{L}\p{N}])/giu;

export function escapeLatex(s: string): string {
  let out = "";
  for (const ch of s) out += SPECIALS[ch] ?? ch;
  return out.replace(UNIT_RE, "$1\\,$2");
}
