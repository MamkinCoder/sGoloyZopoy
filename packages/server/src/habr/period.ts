// CV periods («Mar 2026 — Present», «Декабрь 2025 - н.в.», «2019–2022», «2019») → year/month for Habr's date fields.
export interface YM {
  y: number;
  m: number;
}
export interface Period {
  start: YM;
  /** null = still working there. */
  end: YM | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  янв: 1, фев: 2, мар: 3, апр: 4, май: 5, мая: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
};
const PRESENT = /present|now|н\.?\s?в\.?|настоящ|текущ/i;

/** One side of the dash: «Mar 2026», «март 2026», «03.2026», «2019». A bare year means January (start) or December (end). */
function side(raw: string, endSide: boolean): YM | null {
  const s = raw.trim().toLowerCase();
  const year = /(\d{4})/.exec(s)?.[1];
  if (!year) return null;
  const num = /(?:^|\D)(\d{1,2})[./-]\d{4}/.exec(s)?.[1];
  const word = /[a-zа-яё]{3,}/.exec(s.replace(/\d/g, ""))?.[0].slice(0, 3);
  const m = num ? Number(num) : word ? MONTHS[word] : undefined;
  return { y: Number(year), m: m && m >= 1 && m <= 12 ? m : endSide ? 12 : 1 };
}

/** Null when the text has no recognisable start. «2019» alone is the whole year. */
export function parsePeriod(text: string): Period | null {
  const parts = text.split(/\s*[—–-]\s*(?=\S)/);
  const start = side(parts[0] ?? "", false);
  if (!start) return null;
  if (parts.length === 1) return { start, end: { y: start.y, m: 12 } };
  const tail = parts.slice(1).join("-");
  return { start, end: PRESENT.test(tail) ? null : side(tail, true) };
}
