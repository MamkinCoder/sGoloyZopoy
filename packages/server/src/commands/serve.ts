// sgz serve — HTTP API + panel, scheduler when configured, the always-on agent, graceful shutdown. Wiring only:
// every recurring job (chats, reminders, health, digest, retro, lessons, autopilot) is an agent schedule.
import { errMessage, paths, type User } from "@sgz/shared";
import { serve as honoServe } from "@hono/node-server";
import { createApp } from "../api/index.js";
import { createAppContext, resume } from "../app.js";
import { loadProfileYaml } from "../config/profile.js";
import { generateManualCV, parseVacancyText, pickBaseCV } from "../runner/manual-cv.js";
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
  // The owner's chat sees every seeker; a seeker's own chat only herself.
  const usersOf = (chatId: string) => app.store.listUsers(true).filter((u) => chatId === app.cfg.tgChatId || u.tgChatId === chatId);
  const digestAll = (chatId: string) => usersOf(chatId).map((u) => `${u.name}\n${buildDigest(app.store, u, app.cfg.tz, new Date(), app.cfg.panelUrl)}`).join("\n\n");
  const retroAll = (chatId: string) => usersOf(chatId).map((u) => `${u.name}\n${buildRetro(app.store, u, app.cfg.tz, new Date()) ?? `Мало данных: за неделю меньше ${MIN_SENT} откликов`}`).join("\n\n");
  const HELP = [
    "Команды:",
    "/cv <вакансия> - резюме и сопроводительное под вакансию (PDF + текст письма)",
    "/status - итоги дня",
    "/queue - очередь откликов",
    "/week - итоги недели",
    "/company <название> - история откликов по компании",
    "/salary <слово> - рынок зарплат",
    "/study [компания] - чеклист и промпт к собеседованию",
    "/mock [компания] - тренировка собеседования",
    "/stop - закончить тренировку",
    "/help - этот список",
  ].join("\n");
  const BOT_MENU = [
    { command: "cv", description: "Резюме и письмо под вакансию" },
    { command: "status", description: "Итоги дня" },
    { command: "queue", description: "Очередь откликов" },
    { command: "week", description: "Итоги недели" },
    { command: "company", description: "История откликов по компании" },
    { command: "salary", description: "Рынок зарплат по слову" },
    { command: "study", description: "Чеклист к собеседованию" },
    { command: "mock", description: "Тренировка собеседования" },
    { command: "stop", description: "Закончить тренировку" },
    { command: "help", description: "Список команд" },
  ];
  const onCommand = async (cmd: string, args = "", chatId = "") => {
    if (cmd === "/start") {
      // Access is managed in the panel (users.tgChatId); a chat reaching here is already allowlisted.
      const who = app.store.listUsers().find((u) => u.tgChatId === chatId);
      return `Привет${who ? `, ${who.name}` : ""}! Пришли мне текст вакансии командой /cv - верну резюме под неё в PDF и сопроводительное письмо. Я также веду отклики и собеседования.\n\n${HELP}`;
    }
    if (cmd === "/help") return HELP;
    if (cmd === "/status") return `${app.runner.active() ? `Идёт прогон #${app.runner.active()!.id}` : "Бот свободен"}\n\n${digestAll(chatId)}`;
    if (cmd === "/queue") return usersOf(chatId).map((u) => queueList(app.store, u, app.cfg.panelUrl)).join("\n\n");
    if (cmd === "/company") return companyReport(app.store, args, usersOf(chatId));
    if (cmd === "/salary") {
      if (!args) return "Напиши слово из названия вакансии: /salary go";
      const band = app.store.salaryBand({ titleLike: args });
      return band ? `Вилки в вакансиях «${args}» за 90 дней: ${formatBand(band)}` : `Мало вакансий «${args}» с зарплатой за 90 дней`;
    }
    if (cmd === "/week") return retroAll(chatId);
    if (cmd === "/mock") return startMock(app.store, chatId, args, new Date());
    if (cmd === "/stop") return stopMock(app.store, chatId, new Date());
    if (cmd === "/study") return studyCommand(app, chatId, args, new Date());
    if (cmd === "/cv") {
      const text = args.trim();
      if (!text) return "Пришли текст вакансии одним сообщением: /cv <вставь описание вакансии>";
      // Owner's chat → the primary seeker; a seeker's own chat → herself.
      const user = usersOf(chatId).find((u) => u.tgChatId === chatId) ?? usersOf(chatId)[0];
      if (!user) return "Не нашёл пользователя для этого чата";
      const profile = loadProfileYaml(paths.profile(app.cfg, user.slug));
      const parsed = parseVacancyText(text);
      const base = pickBaseCV(app.cfg, user.slug, profile.directions, parsed.descriptionText);
      if (!base) return `Нет базового резюме в ${paths.cvDir(app.cfg, user.slug)} (ожидается base-<direction>.yaml)`;
      void generateManualCV({ llm: app.llm, resume, store: app.store, cfg: app.cfg, notifier: app.notifier }, { user, profile, base, parsed }).catch((e: unknown) => console.error(`/cv: ${errMessage(e)}`));
      return `Делаю резюме «${parsed.title}»${parsed.company ? ` (${parsed.company})` : ""} на базе base-${base.direction || "default"}. Пришлю PDF и сопроводительное через пару минут.`;
    }
    return HELP;
  };
  // A seeker's chat acts only on that seeker's cards (callback data can be crafted); the owner's chat on anyone's.
  const NOT_YOURS = "это не твоя карточка";
  const tapAllowed = (userId: number | undefined, chatId: string) => canTap(app.store.listUsers(), app.cfg.tgChatId, userId, chatId);
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
      }, {
        fetch: telegramFetch(),
        store: app.store,
        commands: {
          // A getter, read on every update: setting a user's Telegram id in the panel takes effect without a restart.
          get chatIds() {
            return [app.cfg.tgChatId, ...app.store.listUsers().map((u) => u.tgChatId)].filter(Boolean);
          },
          menu: BOT_MENU,
          onCommand,
          onText,
        },
      })
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

/** A seeker's chat acts only on her own cards (callback data can be crafted); the owner's chat on anyone's. */
export const canTap = (users: Pick<User, "id" | "tgChatId">[], ownerChat: string, userId: number | undefined, chatId: string): boolean =>
  userId === undefined || chatId === ownerChat || (users.find((u) => u.id === userId)?.tgChatId || ownerChat) === chatId;
