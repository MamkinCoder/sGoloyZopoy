// sgz serve — HTTP API + panel, scheduler when configured, graceful shutdown.
import { serve as honoServe } from "@hono/node-server";
import { createApp } from "../api/index.js";
import { createAppContext } from "../app.js";
import type { ApiDeps } from "../api/deps.js";
import { readMemAvailableMB } from "../runner/budget.js";
import { createScheduler } from "../scheduler/index.js";
import { telegramFetch } from "../notify/proxy.js";
import { startTelegramCallbacks } from "../notify/telegram.js";
import { parseSkillCallback, resolveSkill } from "../runner/skills.js";
import { handleQueueTap, parseQueueCallback, startPendingSend } from "../runner/queue-cards.js";
import { buildDigest, digestDue, queueList } from "../notify/digest.js";
import { careerRotation } from "../runner/career.js";
import { nextJob } from "../scheduler/autopilot.js";
import { checkHeartbeat } from "../scheduler/health.js";
import { errMessage } from "../runner/util.js";
import type { RunRequest } from "@sgz/shared";

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

  // Chat bot: answer employer chats (the auto «давайте пообщаемся» that follows an отклик) every few
  // minutes while no other run is active. It shares the user's single Chrome profile, so it never
  // overlaps a run. SGZ_CHAT_POLL_MIN=0 turns it off.
  const chatPollMin = Number(process.env.SGZ_CHAT_POLL_MIN ?? 5);
  let lastChatPoll = 0;
  const start = (req: Omit<RunRequest, "dryRun" | "limit" | "trigger">) =>
    app.runner.start({ ...req, dryRun: false, limit: 0, trigger: "schedule" }).catch((e: unknown) => console.error(`sgz serve: ${req.stage}: ${errMessage(e)}`));
  const startChatPoll = () => {
    if (app.runner.active()) return;
    lastChatPoll = Date.now();
    // The interval counts from the poll's end: a slow poll must still leave room for career chunks.
    void start({ userSlug: "all", source: "hh", stage: "chats" }).then(async (id) => {
      if (typeof id === "number") await app.runner.wait(id).catch(() => undefined);
      lastChatPoll = Date.now();
    });
  };
  // Every minute: one job when the runner is idle (see scheduler/autopilot.ts for the order).
  // Career chunks keep a single-run runner from starving the chat bot for hours.
  let lastHealth = Date.now();
  const tick = async () => {
    if (Date.now() - lastHealth >= 30 * 60_000) {
      lastHealth = Date.now();
      void checkHeartbeat(app.store, app.notifier, app.startedAt, app.cfg.tz).catch((e: unknown) => console.error(`sgz serve: heartbeat: ${errMessage(e)}`));
    }
    if (app.runner.active()) return;
    // «Отправить» tapped in Telegram while a run was busy: those go first.
    if (await startPendingSend(app.store, app.runner).catch((e: unknown) => (console.error(`sgz serve: queued send: ${errMessage(e)}`), false))) return;
    const job = nextJob({
      now: Date.now(),
      lastChatPoll,
      chatPollMs: chatPollMin * 60_000,
      touchLastAt: app.store.getSetting("touch_last_at") ?? "",
      careerOn: app.store.getSetting("career_autopilot") !== "0",
      careerDue: () =>
        app.store.listUsers(true).find((u) => {
          const r = careerRotation(app.store, u, app.cfg.tz, new Date());
          return r.budget > 0 && r.sites.length > 0;
        })?.slug ?? null,
    });
    if (job?.kind === "chats") startChatPoll();
    else if (job?.kind === "touch") {
      app.store.setSetting("touch_last_at", new Date().toISOString());
      void start({ userSlug: "all", source: "hh", stage: "touch" });
    } else if (job?.kind === "career") void start({ userSlug: job.userSlug, source: "career", stage: "rotate" });
  };
  // Telegram buttons: queue cards (send / skip) and «есть / нет» answers for unknown skills (update the
  // profile, then answer the waiting chats). /status and /queue answer from the configured chats.
  const digestAll = () => app.store.listUsers(true).map((u) => `${u.name}\n${buildDigest(app.store, u, app.cfg.tz, new Date(), app.cfg.panelUrl)}`).join("\n\n");
  const onCommand = async (cmd: string) => {
    if (cmd === "/status") return `${app.runner.active() ? `Идёт прогон #${app.runner.active()!.id}` : "Бот свободен"}\n\n${digestAll()}`;
    if (cmd === "/queue") return app.store.listUsers(true).map((u) => queueList(app.store, u, app.cfg.panelUrl)).join("\n\n");
    return "Команды: /status - итоги дня, /queue - очередь на проверку";
  };
  const stopCallbacks = app.cfg.tgBotToken
    ? startTelegramCallbacks(app.cfg.tgBotToken, async (data) => {
        const q = parseQueueCallback(data);
        if (q) return handleQueueTap(app.store, app.runner, q);
        const cb = parseSkillCallback(data);
        if (!cb) return "неизвестная кнопка";
        const skill = resolveSkill(app.store, cb.userId, cb.key, cb.has);
        if (!skill) return "уже учтено";
        startChatPoll();
        return cb.has ? `✅ ${skill} добавлен в навыки, отвечаю работодателю` : `❌ ${skill} отмечен как «нет», отвечаю работодателю`;
      }, { fetch: telegramFetch(), commands: { chatIds: [app.cfg.tgChatId, ...app.store.listUsers().map((u) => u.tgChatId)].filter(Boolean), onCommand } })
    : null;
  const chatPoll = app.cfg.runnerEnabled && chatPollMin > 0 ? setInterval(() => void tick(), 60_000) : null;
  // Evening digest: once a day at settings.digest_at ("" = off), independent of the runner.
  const digestTimer = app.cfg.tgBotToken
    ? setInterval(() => {
        const day = digestDue(app.store.getSetting("digest_at") ?? "20:00", app.store.getSetting("digest_last_day") ?? "", new Date(), app.cfg.tz);
        if (!day) return;
        app.store.setSetting("digest_last_day", day);
        for (const u of app.store.listUsers(true))
          void app.notifier.alert(`Итоги дня · ${u.name}`, buildDigest(app.store, u, app.cfg.tz, new Date(), app.cfg.panelUrl)).catch((e: unknown) => console.error(`sgz serve: digest: ${errMessage(e)}`));
      }, 60_000)
    : null;

  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    if (chatPoll) clearInterval(chatPoll);
    if (digestTimer) clearInterval(digestTimer);
    stopCallbacks?.();
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
