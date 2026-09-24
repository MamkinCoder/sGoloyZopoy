// The recurring work of `sgz serve` as agent jobs (docs/ARCHITECTURE.md §2): interview reminders and outcome
// questions, heartbeat and chat-stall alerts, the evening digest, the weekly retro, letter lessons and the runner
// autopilot (parked Telegram sends, then the touch / career rotate chunks). Every schedule is a cheap `due`
// check, so a job exists only when there is work and shows in /api/agent/jobs.
import type { Config, LLMClient, Notifier, RunRequest, RunService } from "@sgz/shared";
import type { JobHandler, Schedule } from "../agent/queue.js";
import type { SqliteStore } from "../db/index.js";
import { buildDigest, digestDue } from "../notify/digest.js";
import { buildRetro, retroDue } from "../notify/retro.js";
import { careerRotation } from "../runner/career.js";
import { askOutcomes, interviewsDue, remindInterviews } from "../runner/interview.js";
import { refreshLessons } from "../runner/learn.js";
import { readPending, startPendingSend } from "../runner/queue-cards.js";
import { errMessage } from "../runner/util.js";
import { nextJob } from "./autopilot.js";
import { chatStallChanged, checkChatStall, checkHeartbeat, heartbeatChanged } from "./health.js";

export interface ServeJobsDeps {
  cfg: Pick<Config, "tz" | "panelUrl" | "tgBotToken" | "runnerEnabled">;
  store: SqliteStore;
  notifier: Notifier;
  llm: LLMClient;
  runner: Pick<RunService, "start" | "active">;
  /** The daily run came while the runner was busy and waits for the idle slot (scheduler.owed()). */
  owed(): boolean;
  startedAt: Date;
  /** chats.sync is scheduled: watch it for stalls. */
  chatsPolled: boolean;
}

const MIN = 60_000;

export function serveJobs(d: ServeJobsDeps): { handlers: Record<string, JobHandler>; schedules: Schedule[] } {
  const { store, notifier, cfg } = d;
  const setting = (k: string, def: string) => store.getSetting(k) ?? def;
  const users = () => store.listUsers(true);
  const warn = (what: string) => (e: unknown) => console.error(`sgz serve: ${what}: ${errMessage(e)}`);
  // Stall baseline: the last chats.sync job that finished done (boot when none yet).
  const lastChatDone = () => {
    const at = Date.parse(store.lastJobAt("chats.sync", "done") ?? "");
    return Math.max(Number.isFinite(at) ? at : 0, d.startedAt.getTime());
  };
  const digestDay = (now: Date) => digestDue(setting("digest_at", "20:00"), setting("digest_last_day", ""), now, cfg.tz);
  const retroDay = (now: Date) => retroDue(setting("retro_day", "sun"), setting("retro_at", "19:00"), setting("retro_last_day", ""), now, cfg.tz);
  const idle = () => !d.runner.active() && !d.owed();
  const autopilotNext = (now: Date) =>
    nextJob({
      now: now.getTime(),
      touchLastAt: setting("touch_last_at", ""),
      careerOn: store.getSetting("career_autopilot") !== "0",
      careerDue: () => users().find((u) => {
        const r = careerRotation(store, u, cfg.tz, now);
        return r.budget > 0 && r.sites.length > 0;
      })?.slug ?? null,
    });
  const start = (req: Omit<RunRequest, "dryRun" | "limit" | "trigger">) =>
    d.runner.start({ ...req, dryRun: false, limit: 0, trigger: "schedule" }).catch((e: unknown) => (warn(req.stage ?? "run")(e), null));

  const handlers: Record<string, JobHandler> = {};
  const schedules: Schedule[] = [];

  if (cfg.runnerEnabled) {
    Object.assign(handlers, {
      "interviews.remind": {
        needs: "none",
        async run(_job, ctx) {
          await remindInterviews(store, notifier, cfg.tz, ctx.now());
          await askOutcomes(store, notifier, ctx.now());
        },
      },
      "health.heartbeat": { needs: "none", run: (_job, ctx) => checkHeartbeat(store, notifier, d.startedAt, cfg.tz, ctx.now()) },
      "health.chats": { needs: "none", run: (_job, ctx) => checkChatStall(store, notifier, lastChatDone(), cfg.tz, ctx.now().getTime()) },
      // Letter lessons: rebuilt weekly per user once enough outcomes exist (runner/learn.ts); an llm job, so it
      // takes the agent's LLM lane instead of racing it.
      "learn.lessons": {
        needs: "llm",
        leaseMs: 15 * MIN,
        async run(_job, ctx) {
          for (const u of users()) await refreshLessons(store, d.llm, u, ctx.now());
        },
      },
      // The main runner lane while it is idle: «Отправить» tapped during a run goes first, then one batch job.
      "runner.autopilot": {
        needs: "none",
        async run(_job, ctx) {
          if (d.runner.active()) return;
          if (await startPendingSend(store, d.runner).catch((e: unknown) => (warn("queued send")(e), false))) return;
          if (!idle()) return; // a run started meanwhile, or the daily run's retry owns the slot
          const job = autopilotNext(ctx.now());
          // touch_last_at only once the run really started: a RunBusyError must not skip the raise for 4 h.
          if (job?.kind === "touch") {
            if (typeof (await start({ userSlug: "all", source: "hh", stage: "touch" })) === "number") store.setSetting("touch_last_at", ctx.now().toISOString());
          } else if (job?.kind === "career") await start({ userSlug: job.userSlug, source: "career", stage: "rotate" });
        },
      },
    } satisfies Record<string, JobHandler>);
    schedules.push(
      { kind: "interviews.remind", everyMs: MIN, due: (now) => interviewsDue(store, notifier, now) },
      { kind: "health.heartbeat", everyMs: 30 * MIN, due: (now) => heartbeatChanged(store, d.startedAt, now) },
      { kind: "learn.lessons", everyMs: 60 * MIN, due: idle },
      { kind: "runner.autopilot", everyMs: MIN, due: (now) => !d.runner.active() && (readPending(store).length > 0 || (!d.owed() && autopilotNext(now) !== null)) },
    );
    if (d.chatsPolled) schedules.push({ kind: "health.chats", everyMs: MIN, due: (now) => chatStallChanged(store, lastChatDone(), now.getTime()) });
  }

  // Evening digest (settings.digest_at, "" = off) and weekly retro (retro_day "sun" default, "" = off, at retro_at;
  // a too-small week sends nothing): once per day key, independent of the runner.
  if (cfg.tgBotToken) {
    Object.assign(handlers, {
      "digest.day": {
        needs: "none",
        async run(_job, ctx) {
          const now = ctx.now();
          const day = digestDay(now);
          if (!day) return;
          store.setSetting("digest_last_day", day);
          for (const u of users()) await notifier.alert(`Итоги дня · ${u.name}`, buildDigest(store, u, cfg.tz, now, cfg.panelUrl)).catch(warn("digest"));
        },
      },
      "digest.week": {
        needs: "none",
        async run(_job, ctx) {
          const now = ctx.now();
          const day = retroDay(now);
          if (!day) return;
          store.setSetting("retro_last_day", day);
          for (const u of users()) {
            const text = buildRetro(store, u, cfg.tz, now);
            if (text) await notifier.alert(`Итоги недели · ${u.name}`, text).catch(warn("retro"));
          }
        },
      },
    } satisfies Record<string, JobHandler>);
    schedules.push({ kind: "digest.day", everyMs: MIN, due: (now) => digestDay(now) !== null }, { kind: "digest.week", everyMs: MIN, due: (now) => retroDay(now) !== null });
  }
  return { handlers, schedules };
}
