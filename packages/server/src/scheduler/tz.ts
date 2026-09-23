// Time-zone math with Intl only (no deps): wall-clock parts in a zone, local → UTC conversion.

export interface Parts {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(date: Date, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(date)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year ?? 1970, m: p.month ?? 1, d: p.day ?? 1, h: (p.hour ?? 0) % 24, mi: p.minute ?? 0, s: p.second ?? 0 };
}

/** Offset (ms) such that wallClockAsUTC = utc + offset. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Wall-clock time in `tz` → instant. Handles DST by re-checking the offset once. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of the instant in `tz`. */
export function dayInTz(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** "dd.MM HH:mm" of the instant in `tz`. */
export function shortStamp(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.d)}.${pad(p.m)} ${pad(p.h)}:${pad(p.mi)}`;
}

/** Add whole days to a Y-M-D triple (UTC arithmetic, no tz involved). */
export function addDays(p: Pick<Parts, "y" | "m" | "d">, days: number): Pick<Parts, "y" | "m" | "d"> {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
