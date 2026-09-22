import { Hono } from "hono";
import type { HealthDTO } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { parseBody, SETTING_KEYS, SettingsSchema } from "../validate.js";

const DEDUP_WINDOW_DAYS_DEFAULT = "60";

export function systemRoutes(deps: ApiDeps): Hono {
  const { store, cfg } = deps;
  const r = new Hono();
  const startedAt = Date.now();

  r.get("/health", (c) => {
    const users = store.listUsers().map((u) => {
      const s = deps.hhSessionCheck?.(u.slug) ?? { ok: null, cookiesAgeH: null };
      return { slug: u.slug, hh_login_ok: s.ok, cookies_age_h: s.cookiesAgeH };
    });
    const body: HealthDTO = {
      ok: true,
      version: deps.version,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      mem_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      mem_available_mb: deps.memAvailableMB?.() ?? null,
      active_run_id: deps.runner.active()?.id ?? null,
      scheduler_next: deps.schedulerNext?.() ?? null,
      users,
      tools: deps.toolVersions?.() ?? { chromium: null, claude: null, xelatex: null },
    };
    return c.json(body);
  });

  const defaults: Record<(typeof SETTING_KEYS)[number], string> = {
    schedule_at: cfg.scheduleAt,
    schedule_jitter_min: String(cfg.scheduleJitterMin),
    dedup_window_days: DEDUP_WINDOW_DAYS_DEFAULT,
    tz: cfg.tz,
  };
  const readSettings = (): Record<string, string> =>
    Object.fromEntries(SETTING_KEYS.map((k) => [k, store.getSetting(k) ?? defaults[k]]));

  r.get("/settings", (c) => c.json(readSettings()));

  r.put("/settings", async (c) => {
    const b = await parseBody(c, SettingsSchema);
    for (const k of SETTING_KEYS) {
      const v = b[k];
      if (v !== undefined) store.setSetting(k, v);
    }
    const settings = readSettings();
    deps.settingsChanged?.(settings);
    return c.json(settings);
  });

  return r;
}
