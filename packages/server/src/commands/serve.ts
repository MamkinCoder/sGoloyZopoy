// sgz serve — HTTP API + panel, scheduler when configured, graceful shutdown.
import { serve as honoServe } from "@hono/node-server";
import { createApp } from "../api/index.js";
import { createAppContext } from "../app.js";
import type { ApiDeps } from "../api/deps.js";
import { readMemAvailableMB } from "../runner/budget.js";
import { createScheduler } from "../scheduler/index.js";

export async function serve(): Promise<void> {
  const app = await createAppContext({ withScheduler: true });
  const hono = createApp({
    cfg: app.cfg,
    store: app.store,
    runner: app.runner,
    version: app.version,
    schedulerNext: () => app.scheduler?.running() ? app.scheduler.next().toISOString() : null,
    settingsChanged: (settings) => {
      app.cfg.scheduleAt = settings.schedule_at ?? app.cfg.scheduleAt;
      app.cfg.scheduleJitterMin = Number(settings.schedule_jitter_min ?? app.cfg.scheduleJitterMin);
      app.cfg.tz = settings.tz ?? app.cfg.tz;
      if (!app.cfg.scheduleAt || !app.cfg.runnerEnabled) {
        app.scheduler?.stop();
        return;
      }
      if (!app.scheduler) {
        app.scheduler = createScheduler(app.runner, { at: app.cfg.scheduleAt, tz: app.cfg.tz, jitterMin: app.cfg.scheduleJitterMin });
        app.scheduler.start();
      } else {
        app.scheduler.configure({ at: app.cfg.scheduleAt, jitterMin: app.cfg.scheduleJitterMin, tz: app.cfg.tz });
        if (!app.scheduler.running()) app.scheduler.start();
      }
    },
    memAvailableMB: readMemAvailableMB,
  } satisfies ApiDeps);

  const server = honoServe({ fetch: hono.fetch as never, hostname: app.cfg.bind.host, port: app.cfg.bind.port }, (info) => {
    console.error(`sgz serve: listening on http://${info.address}:${info.port}`);
  });
  if (app.scheduler) app.scheduler.start();
  else console.error(`sgz serve: scheduler off (scheduleAt="${app.cfg.scheduleAt}", runnerEnabled=${app.cfg.runnerEnabled})`);

  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    console.error(`sgz serve: ${sig}, shutting down`);
    server.close();
    const t = setTimeout(() => process.exit(1), 30_000);
    t.unref();
    void app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await new Promise<void>(() => undefined); // keep the process alive; signals end it
}
