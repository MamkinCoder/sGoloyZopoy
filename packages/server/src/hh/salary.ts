// Parses hh salary strings and InitialState compensation objects into {from,to,currency}.
// Gross («до вычета налогов») is converted to net with the 13% NDFL rule (×0.87), rounded to 1.

export interface Salary {
  from: number;
  to: number;
  currency: string; // RUR | USD | EUR | KZT | BYR | UZS | "" when unknown
}

const GROSS_TO_NET = 0.87;
const NBSP = /[   \s]/g;

const CURRENCY_TOKENS: [RegExp, string][] = [
  [/₽|руб|RUR|RUB/i, "RUR"],
  [/\$|USD|долл/i, "USD"],
  [/€|EUR|евро/i, "EUR"],
  [/₸|KZT|тенге/i, "KZT"],
  [/Br|BYN|BYR|бел\.?\s*руб/i, "BYR"],
  [/UZS|сум/i, "UZS"],
  [/₴|UAH|грн/i, "UAH"],
  [/₾|GEL|лари/i, "GEL"],
  [/£|GBP/i, "GBP"],
];

const detectCurrency = (text: string): string => {
  for (const [re, iso] of CURRENCY_TOKENS) if (re.test(text)) return iso;
  return "";
};

const normalizeCurrency = (code: string): string => {
  const c = code.trim();
  return c && (detectCurrency(c) || c.toUpperCase());
};

const toNumber = (s: string): number => Number(s.replace(NBSP, "").replace(/,/g, "."));

/**
 * «от 100 000 до 150 000 ₽ за месяц, на руки» → {100000,150000,RUR}
 * «до 150 000 ₽ до вычета налогов» → {0, 130500, RUR}
 * «$2 000 – $3 000» → {2000, 3000, USD}
 * Unparseable / «з/п не указана» → {0,0,""}.
 */
export const parseSalary = (raw: string | null | undefined): Salary => {
  const empty: Salary = { from: 0, to: 0, currency: "" };
  if (!raw) return empty;
  const text = raw.replace(NBSP, " ").trim();
  if (!text) return empty;
  const gross = /до вычета|gross|до уплаты налог/i.test(text);
  // Join digit groups: "100 000" → "100000" (only between digit groups of 3).
  const compact = text.replace(/(\d)[ ](?=\d{3}\b)/g, "$1");
  const nums = [...compact.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => toNumber(m[0])).filter((n) => n > 0);
  if (nums.length === 0) return empty;
  let from = 0;
  let to = 0;
  const hasFrom = /\bот\b|\bfrom\b/i.test(compact);
  const hasTo = /\bдо\b|\bto\b|\bup to\b/i.test(compact.replace(/до вычета|до уплаты/gi, ""));
  const range = /\d\s*[-–—]\s*\d/.test(compact);
  if (nums.length >= 2 && (range || (hasFrom && hasTo))) {
    from = nums[0]!;
    to = nums[1]!;
  } else if (hasFrom && !hasTo) from = nums[0]!;
  else if (hasTo && !hasFrom) to = nums[0]!;
  else if (nums.length >= 2) {
    from = nums[0]!;
    to = nums[1]!;
  } else from = to = nums[0]!;
  const factor = gross ? GROSS_TO_NET : 1;
  const currency = detectCurrency(text);
  return { from: Math.round(from * factor), to: Math.round(to * factor), currency };
};

/** hh InitialState `compensation`: {from, to, currencyCode, gross} (names unverified; several tried). */
export const salaryFromCompensation = (c: unknown): Salary => {
  const empty: Salary = { from: 0, to: 0, currency: "" };
  if (!c || typeof c !== "object") return empty;
  const o = c as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
  const from = num(o.from ?? o.salaryFrom ?? o.min);
  const to = num(o.to ?? o.salaryTo ?? o.max);
  if (!from && !to) return empty;
  const gross = o.gross === true || o.gross === "true";
  const factor = gross ? GROSS_TO_NET : 1;
  const currency = normalizeCurrency(String(o.currencyCode ?? o.currency ?? o.code ?? ""));
  return { from: Math.round(from * factor), to: Math.round(to * factor), currency };
};
