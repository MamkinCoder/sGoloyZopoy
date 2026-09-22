const DAY_MS = 86_400_000;

/**
 * True when `hash` (company+title) was already applied to within `windowDays` of `nowISO`.
 * `seen` maps dedupHash → ISO timestamp of the last SENT application.
 */
export function shouldSkipDedup(seen: Map<string, string>, hash: string, nowISO: string, windowDays: number): boolean {
  const last = seen.get(hash);
  if (!last) return false;
  const lastMs = Date.parse(last);
  const nowMs = Date.parse(nowISO);
  if (Number.isNaN(lastMs) || Number.isNaN(nowMs)) return false;
  return nowMs - lastMs < windowDays * DAY_MS;
}
