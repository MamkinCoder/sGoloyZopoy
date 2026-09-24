// sgz serve — HTTP API + panel, scheduler when configured, the always-on agent, graceful shutdown. Wiring only:
// every recurring job (chats, reminders, health, digest, retro, lessons, autopilot) is an agent schedule.
import { serve as honoServe } from "@hono/node-server";
import { createApp } from "../api/index.js";
import { createAppContext } from "../app.js";
import type { ApiDeps } from "../api/deps.js";
import { readMemAvailableMB } from "../runner/budget.js";
import { createScheduler } from "../scheduler/index.js";
import { telegramFetch } from "../notify/proxy.js";
import { startTelegramCallbacks } from "../notify/telegram.js";
import { kbText, onKbTap, parseKbCallback } from "../agent/chats/review.js";
import { handleQueueTap, parseQueueCallback } from "../runner/queue-cards.js";
import { buildDigest, queueList } from "../notify/digest.js";
import { OUTCOME_LABEL, parseOutcomeCallback } from "../runner/interview.js";
import { companyReport } from "../runner/learn.js";
import { formatBand } from "../db/salary.js";
import { buildRetro, MIN_SENT } from "../notify/retro.js";
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

  // The always-on agent: employer chats (chats.sync every SGZ_CHAT_POLL_MIN, reply tasks, Telegram cards) on its own
  // Chrome profile, plus serve's recurring jobs (scheduler/jobs.ts). See docs/ARCHITECTURE.md §2-3.
  app.agent?.start();
  // Taps and stories only feed chat jobs; with the runner off nothing would run them, so they are refused.
  const chats = app.cfg.runnerEnabled ? app.chats : null;
  const AGENT_OFF = "агент выключен (SGZ_RUNNER=false): ответь в чате сам";
  // Telegram buttons: queue cards (send / skip), «📚 Чеклист» (runner/study.ts) and the chat reply cards'
  // KB review buttons «Подтвердить / Дополнить / Нет навыка» per topic (agent/chats/review.ts: the answer goes into the task, the card is edited in place; old phase-1
  // «ct:» and one-skill «sk:» cards only get «кнопка устарела»). /status and /queue answer from the configured chats.
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
  // A seeker's chat acts only on that seeker's cards (callback data can be crafted); the owner's chat on anyone's.
  const NOT_YOURS = "это не твоя карточка";
  const tapAllowed = (userId: number | undefined, chatId: string) =>
    userId === undefined || chatId === app.cfg.tgChatId || (app.store.listUsers().find((u) => u.id === userId)?.tgChatId || app.cfg.tgChatId) === chatId;
  // Free text: a story for a KB review that asked for one («Дополнить») first, otherwise a /mock answer.
  const onText = async (chatId: string, text: string) => (chats ? kbText(chats, chatId, text) : null) ?? mockAnswer(app.store, app.llm, chatId, text, new Date());
  const stopCallbacks = app.cfg.tgBotToken
    ? startTelegramCallbacks(app.cfg.tgBotToken, async (data, chatId) => {
        const kr = parseKbCallback(data);
        if (kr && !tapAllowed(app.store.getKbReview(kr.reviewId)?.userId, chatId)) return NOT_YOURS;
        if (kr) return chats ? onKbTap(chats, kr, chatId) : AGENT_OFF;
        const q = parseQueueCallback(data);
        if (q && !tapAllowed(app.store.getApplication(q.id)?.application.userId, chatId)) return NOT_YOURS;
        if (q) return handleQueueTap(app.store, app.runner, q);
        const st = parseStudyCallback(data);
        if (st && !tapAllowed(app.store.getChatThread(st.threadId)?.userId, chatId)) return NOT_YOURS;
        if (st) return studyTap(app, st, new Date());
        const io = parseOutcomeCallback(data);
        if (io && !tapAllowed(app.store.getChatThread(io.threadId)?.userId, chatId)) return NOT_YOURS;
        if (io) {
          app.store.setInterviewOutcome(io.threadId, io.outcome);
          return `Записал: ${OUTCOME_LABEL[io.outcome]}`;
        }
        return "кнопка устарела"; // old cards (phase-1 «ct:», one-skill «sk:») and anything unknown
      }, { fetch: telegramFetch(), store: app.store, commands: { chatIds: [app.cfg.tgChatId, ...app.store.listUsers().map((u) => u.tgChatId)].filter(Boolean), onCommand, onText } })
    : null;
  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
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
