// Scrubs recordings before they become public fixtures: replaces names/phones/emails/hashes
// with placeholders so real personal data never lands in test/hh/fixtures.

export interface ScrubReplacement {
  find: string | RegExp;
  replace: string;
}

const DEFAULT_RULES: ScrubReplacement[] = [
  { find: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replace: "user@example.com" },
  { find: /(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, replace: "+7 000 000-00-00" },
  { find: /"hhtoken":"[^"]*"/g, replace: '"hhtoken":"SCRUBBED"' },
  { find: /"phone":"[^"]*"/g, replace: '"phone":"+70000000000"' },
  { find: /"email":"[^"]*"/g, replace: '"email":"user@example.com"' },
  { find: /"xsrfToken":"[^"]*"/g, replace: '"xsrfToken":"SCRUBBED"' },
  { find: /"userId":\s*\d+/g, replace: '"userId":0' },
];

/**
 * Applies `replacements` (literal strings are replaced globally, RegExps as given) and then the
 * built-in rules. Order matters: user rules first so a known full name is gone before generic rules run.
 */
export const scrubHtml = (html: string, replacements: ScrubReplacement[] = [], opts?: { builtins?: boolean }): string => {
  let out = html;
  const rules = opts?.builtins === false ? replacements : [...replacements, ...DEFAULT_RULES];
  for (const r of rules) {
    if (typeof r.find === "string") {
      if (r.find) out = out.split(r.find).join(r.replace);
    } else out = out.replace(r.find, r.replace);
  }
  return out;
};
