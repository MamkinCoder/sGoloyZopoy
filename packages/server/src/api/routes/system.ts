import { Hono } from "hono";
import type { HealthDTO } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { careerRotation } from "../../runner/career.js";
import { parseBody, SETTING_KEYS, SettingsSchema } from "../validate.js";

const DEDUP_WINDOW_DAYS_DEFAULT = "60";
const COMPANY_LIMIT_MAX_DEFAULT = "10";
const COMPANY_LIMIT_WINDOW_DAYS_DEFAULT = "30";
const COMPANY_LIMIT_PERSONA_LOCK_DEFAULT = "1";

export function systemRoutes(deps: ApiDeps): Hono {
  const { store, cfg } = deps;
  const r = new Hono();
  const startedAt = Date.now();

  r.get("/health", (c) => {
    const users = store.listUsers().map((u) => {
      const s = deps.hhSessionCheck?.(u.slug) ?? { ok: null, cookiesAgeH: null };
      const rot = careerRotation(store, u, cfg.tz, new Date());
      const career = { sites_enabled: store.listCareerSites(u.id, true).length, sites_left_today: rot.sites.length, queue_left: rot.budget, daily_limit: u.dailyLimitCareer };
      return { slug: u.slug, hh_login_ok: s.ok, cookies_age_h: s.cookiesAgeH, career };
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
      touch_last_at: store.getSetting("touch_last_at") || null,
    };
    return c.json(body);
  });

  const defaults: Record<(typeof SETTING_KEYS)[number], string> = {
    schedule_at: cfg.scheduleAt,
    schedule_jitter_min: String(cfg.scheduleJitterMin),
    dedup_window_days: DEDUP_WINDOW_DAYS_DEFAULT,
    tz: cfg.tz,
    company_limit_max: COMPANY_LIMIT_MAX_DEFAULT,
    company_limit_window_days: COMPANY_LIMIT_WINDOW_DAYS_DEFAULT,
    company_limit_persona_lock: COMPANY_LIMIT_PERSONA_LOCK_DEFAULT,
    feedback_request: "1",
    chat_track_since: "2026-09-23",
    career_per_site: "3",
    career_sites_per_run: "1",
    career_autopilot: "1",
    run_max_min: "0",
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
