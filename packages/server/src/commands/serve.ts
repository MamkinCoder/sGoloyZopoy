// sgz serve — HTTP API + panel, scheduler when configured, the always-on agent, graceful shutdown.
import { serve as honoServe } from "@hono/node-server";
import { createApp } from "../api/index.js";
import { createAppContext } from "../app.js";
import type { ApiDeps } from "../api/deps.js";
import { readMemAvailableMB } from "../runner/budget.js";
import { createScheduler } from "../scheduler/index.js";
import { telegramFetch } from "../notify/proxy.js";
import { startTelegramCallbacks } from "../notify/telegram.js";
import { parseSkillCallback } from "../runner/skills.js";
import { onCardTap, onLegacySkillTap } from "../agent/chats/tasks.js";
import { kbText, onKbTap, parseCardCallback, parseKbCallback } from "../agent/chats/review.js";
import { chatSchedules } from "../agent/chats/index.js";
import { handleQueueTap, parseQueueCallback, startPendingSend } from "../runner/queue-cards.js";
import { buildDigest, digestDue, queueList } from "../notify/digest.js";
import { careerRotation } from "../runner/career.js";
import { askOutcomes, OUTCOME_LABEL, parseOutcomeCallback, remindInterviews } from "../runner/interview.js";
import { companyReport, refreshLessons } from "../runner/learn.js";
import { formatBand } from "../db/salary.js";
import { nextJob } from "../scheduler/autopilot.js";
import { checkChatStall, checkHeartbeat } from "../scheduler/health.js";
import { errMessage } from "../runner/util.js";
import type { RunRequest } from "@sgz/shared";
import { buildRetro, MIN_SENT, retroDue } from "../notify/retro.js";
import { mockAnswer, startMock, stopMock } from "../runner/mock.js";
import { parseStudyCallback, studyCommand, studyTap } from "../runner/study.js";

export async function serve(): Promise<void> {
  const app = await createAppContext({ withScheduler: true });
  const hono = createApp({
    cfg: app.cfg,
    store: app.store,
    runner: app.runner,
    llm: app.llm,
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
    agent: { jobs: (state) => app.store.listJobs(state, 100), tasks: (userId) => app.store.latestChatTasks(userId) },
  } satisfies ApiDeps);

  const server = honoServe({ fetch: hono.fetch as never, hostname: app.cfg.bind.host, port: app.cfg.bind.port }, (info) => {
    console.error(`sgz serve: listening on http://${info.address}:${info.port}`);
  });
  if (app.scheduler) app.scheduler.start();
  else console.error(`sgz serve: scheduler off (scheduleAt="${app.cfg.scheduleAt}", runnerEnabled=${app.cfg.runnerEnabled})`);

  // The always-on agent answers employer chats (chats.sync every SGZ_CHAT_POLL_MIN, reply tasks, Telegram
  // cards) on its own Chrome profile, independent of batch runs. See docs/ARCHITECTURE.md §2-3.
  const agent = app.cfg.runnerEnabled ? app.agent : null;
  agent?.start();
  const chatsOn = !!agent && chatSchedules().length > 0;
  const start = (req: Omit<RunRequest, "dryRun" | "limit" | "trigger">) =>
    app.runner.start({ ...req, dryRun: false, limit: 0, trigger: "schedule" }).catch((e: unknown) => console.error(`sgz serve: ${req.stage}: ${errMessage(e)}`));
  // Every minute: reminders and health checks, then one batch job when the runner is idle
  // (see scheduler/autopilot.ts for the order).
  let lastHealth = Date.now();
  let lastLearn = 0;
  let learning = false;
  const tick = async () => {
    void remindInterviews(app.store, app.notifier, app.cfg.tz).catch((e: unknown) => console.error(`sgz serve: interview reminders: ${errMessage(e)}`));
    void askOutcomes(app.store, app.notifier).catch((e: unknown) => console.error(`sgz serve: interview outcomes: ${errMessage(e)}`));
    if (Date.now() - lastHealth >= 30 * 60_000) {
      lastHealth = Date.now();
      void checkHeartbeat(app.store, app.notifier, app.startedAt, app.cfg.tz).catch((e: unknown) => console.error(`sgz serve: heartbeat: ${errMessage(e)}`));
    }
    if (chatsOn) {
      // Stall baseline: the last chats.sync job that finished done (boot when none yet).
      const lastSync = Date.parse(app.store.lastJobAt("chats.sync", "done") ?? "");
      const lastChatDone = Math.max(Number.isFinite(lastSync) ? lastSync : 0, app.startedAt.getTime());
      void checkChatStall(app.store, app.notifier, lastChatDone, app.cfg.tz).catch((e: unknown) => console.error(`sgz serve: chat stall: ${errMessage(e)}`));
    }
    if (app.runner.active()) return;
    // «Отправить» tapped in Telegram while a run was busy: those go first.
    if (await startPendingSend(app.store, app.runner).catch((e: unknown) => (console.error(`sgz serve: queued send: ${errMessage(e)}`), false))) return;
    if (app.runner.active()) return; // a panel / Telegram run started during the await
    if (app.scheduler?.owed()) return; // the daily run waits for the idle slot: its retry takes it, not a new chunk
    // Letter lessons: checked hourly, rebuilt weekly per user once enough outcomes exist (runner/learn.ts).
    if (!learning && Date.now() - lastLearn >= 60 * 60_000) {
      lastLearn = Date.now();
      learning = true;
      void (async () => {
        for (const u of app.store.listUsers(true)) await refreshLessons(app.store, app.llm, u);
      })()
        .catch((e: unknown) => console.error(`sgz serve: letter lessons: ${errMessage(e)}`))
        .finally(() => (learning = false));
    }
    const job = nextJob({
      now: Date.now(),
      touchLastAt: app.store.getSetting("touch_last_at") ?? "",
      careerOn: app.store.getSetting("career_autopilot") !== "0",
      careerDue: () =>
        app.store.listUsers(true).find((u) => {
          const r = careerRotation(app.store, u, app.cfg.tz, new Date());
          return r.budget > 0 && r.sites.length > 0;
        })?.slug ?? null,
    });
    // touch_last_at only once the run really started: a RunBusyError must not skip the raise for 4 h.
    if (job?.kind === "touch") void start({ userSlug: "all", source: "hh", stage: "touch" }).then((id) => typeof id === "number" && app.store.setSetting("touch_last_at", new Date().toISOString())); else if (job?.kind === "career") void start({ userSlug: job.userSlug, source: "career", stage: "rotate" });
  };
  // Telegram buttons: queue cards (send / skip), «📚 Чеклист» (runner/study.ts) and the chat reply cards'
  // KB review buttons «Подтвердить / Дополнить / Нет навыка» per topic (agent/chats/review.ts: the answer goes into the task, the card is edited in place; phase-1 «ct:» ✅/❌ and old one-skill
  // «sk:» cards map to the open task). /status and /queue answer from the configured chats.
  const digestAll = () => app.store.listUsers(true).map((u) => `${u.name}\n${buildDigest(app.store, u, app.cfg.tz, new Date(), app.cfg.panelUrl)}`).join("\n\n");
  const retroAll = () => app.store.listUsers(true).map((u) => `${u.name}\n${buildRetro(app.store, u, app.cfg.tz, new Date()) ?? `Мало данных: за неделю меньше ${MIN_SENT} откликов`}`).join("\n\n");
  const onCommand = async (cmd: string, args = "", chatId = "") => {
    if (cmd === "/status") return `${app.runner.active() ? `Идёт прогон #${app.runner.active()!.id}` : "Бот свободен"}\n\n${digestAll()}`;
    if (cmd === "/queue") return app.store.listUsers(true).map((u) => queueList(app.store, u, app.cfg.panelUrl)).join("\n\n");
    if (cmd === "/company") return companyReport(app.store, args);
    if (cmd === "/salary") {
      if (!args) return "Напиши слово из названия вакансии: /salary go";
      const band = app.store.salaryBand({ titleLike: args });
      return band ? `Вилки в вакансиях «${args}» за 90 дней: ${formatBand(band)}` : `Мало вакансий «${args}» с зарплатой за 90 дней`;
    }
    if (cmd === "/week") return retroAll();
    if (cmd === "/mock") return startMock(app.store, chatId, args, new Date());
    if (cmd === "/stop") return stopMock(app.store, chatId, new Date());
    if (cmd === "/study") return studyCommand(app, chatId, args, new Date());
    return "Команды: /status - итоги дня, /queue - очередь, /week - итоги недели, /company <название> - история откликов, /salary <слово> - рынок зарплат, /study [компания] - чеклист и промпт к собеседованию, /mock [компания] - тренировка собеседования, /stop - закончить тренировку";
  };
  // Free text: a story for a KB review that asked for one («Дополнить») first, otherwise a /mock answer.
  const onText = async (chatId: string, text: string) => (app.chats ? kbText(app.chats, chatId, text) : null) ?? mockAnswer(app.store, app.llm, chatId, text, new Date());
  const stopCallbacks = app.cfg.tgBotToken
    ? startTelegramCallbacks(app.cfg.tgBotToken, async (data, chatId) => {
        const kr = parseKbCallback(data);
        if (kr && app.chats) return onKbTap(app.chats, kr, chatId);
        const q = parseQueueCallback(data);
        if (q) return handleQueueTap(app.store, app.runner, q);
        const st = parseStudyCallback(data);
        if (st) return studyTap(app, st, new Date());
        const io = parseOutcomeCallback(data);
        if (io) {
          app.store.setInterviewOutcome(io.threadId, io.outcome);
          return `Записал: ${OUTCOME_LABEL[io.outcome]}`;
        }
        const card = parseCardCallback(data);
        if (card && app.chats) return onCardTap(app.chats, card);
        const cb = parseSkillCallback(data);
        if (cb && app.chats) return onLegacySkillTap(app.chats, cb);
        return "неизвестная кнопка";
      }, { fetch: telegramFetch(), commands: { chatIds: [app.cfg.tgChatId, ...app.store.listUsers().map((u) => u.tgChatId)].filter(Boolean), onCommand, onText } })
    : null;
  const chatPoll = app.cfg.runnerEnabled ? setInterval(() => void tick(), 60_000) : null;
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
  // Weekly retro: settings.retro_day ("sun" default, "" = off) at retro_at; a too-small week sends nothing.
  const retroTimer = app.cfg.tgBotToken
    ? setInterval(() => {
        const day = retroDue(app.store.getSetting("retro_day") ?? "sun", app.store.getSetting("retro_at") ?? "19:00", app.store.getSetting("retro_last_day") ?? "", new Date(), app.cfg.tz);
        if (!day) return;
        app.store.setSetting("retro_last_day", day);
        for (const u of app.store.listUsers(true)) {
          const text = buildRetro(app.store, u, app.cfg.tz, new Date());
          if (text) void app.notifier.alert(`Итоги недели · ${u.name}`, text).catch((e: unknown) => console.error(`sgz serve: retro: ${errMessage(e)}`));
        }
      }, 60_000)
    : null;

  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    if (chatPoll) clearInterval(chatPoll);
    if (digestTimer) clearInterval(digestTimer);
    if (retroTimer) clearInterval(retroTimer);
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
