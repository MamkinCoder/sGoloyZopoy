const pad = (n: number) => String(n).padStart(2, "0");

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Relative time in Russian: «5 мин назад», «через 2 ч». */
export function fmtRel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  const unit =
    abs < 60 ? `${abs} с` : abs < 3600 ? `${Math.round(abs / 60)} мин` : abs < 86400 ? `${Math.round(abs / 3600)} ч` : `${Math.round(abs / 86400)} д`;
  return diff < 0 ? `${unit} назад` : `через ${unit}`;
}

export function fmtDuration(startIso: string, endIso: string | null): string {
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${pad(s % 60)} с`;
  return `${Math.floor(m / 60)} ч ${pad(m % 60)} мин`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("ru-RU").format(n);
}

export function fmtSalary(from: number, to: number, currency: string): string {
  if (!from && !to) return "—";
  const cur = currency === "RUR" || currency === "RUB" || !currency ? "₽" : currency;
  if (from && to) return `${fmtInt(from)}–${fmtInt(to)} ${cur}`;
  if (from) return `от ${fmtInt(from)} ${cur}`;
  return `до ${fmtInt(to)} ${cur}`;
}

export function fmtMb(n: number | null | undefined): string {
  return n == null ? "—" : `${Math.round(n)} МБ`;
}
