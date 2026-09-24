// Composition root: config, store, LLM, browser, hh, career, resume, notifier, runner, scheduler, agent.
import type { Config, LLMClient, Notifier } from "@sgz/shared";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "@sgz/shared";
import { createLauncher, loadCookies } from "./browser/index.js";
import { createAppAgent, type Agent, type ChatEnv } from "./agent/index.js";
import { createCareerAgent } from "./career/agent.js";
import { ensureDirs, loadConfig } from "./config/index.js";
import { openStore, seedDefaultUsers, type SqliteStore } from "./db/index.js";
import { createHabrClient } from "./habr/client.js";
import { createHHClient } from "./hh/index.js";
import { createLLM } from "./llm/index.js";
import { telegramFetch } from "./notify/proxy.js";
import { createTelegram } from "./notify/telegram.js";
import { buildPdf, loadCV, renderTex, validateCV } from "./resume/index.js";
import { resolveLatexBin } from "./resume/build.js";
import { createRunner, type Runner } from "./runner/service.js";
import type { ResumeDeps } from "./runner/deps.js";
import { createScheduler, type Scheduler } from "./scheduler/index.js";

export interface AppContext {
  cfg: Config;
  store: SqliteStore;
  notifier: Notifier;
  llm: LLMClient;
  runner: Runner;
  scheduler: Scheduler | null;
  /** The always-on agent (serve only; not started yet) and the env its chat jobs run with. */
  agent: Agent | null;
  chats: ChatEnv | null;
  version: string;
  startedAt: Date;
  close(): Promise<void>;
}

const resume: ResumeDeps = {
  loadCV: async (p) => loadCV(p),
  renderTex,
  async buildPdf(o) {
    const texPath = o.outPdf.replace(/\.pdf$/i, ".tex");
    await mkdir(dirname(texPath), { recursive: true });
    await writeFile(texPath, o.tex, "utf8");
    await buildPdf({ texSource: o.tex, texDir: o.texDir, outPdf: o.outPdf, latexBin: await resolveLatexBin(o.xelatexBin) });
    return { pdfPath: o.outPdf, texPath };
  },
  validateCV,
};

export async function createAppContext(opts: { withScheduler?: boolean } = {}): Promise<AppContext> {
  const warn = (m: string) => console.error(m);

  const cfg = loadConfig();
  ensureDirs(cfg);

  const store = openStore(paths.db(cfg));
  seedDefaultUsers(store);
  // serve owns the db: no runner exists yet, so every running/queued row was left by a crash or
  // power loss. CLI commands skip this so they never close a live run of a serve beside them.
  if (opts.withScheduler) {
    const orphans = store.reconcileOrphanedRuns(new Date().toISOString());
    if (orphans > 0) warn(`app: closed ${orphans} run(s) orphaned by a restart`);
  }
  // Panel settings are persisted in SQLite; apply the scheduler subset on the
  // next boot so a restart does not silently revert the user's choices.
  const savedSchedule = store.getSetting("schedule_at");
  if (savedSchedule === "" || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(savedSchedule ?? "")) cfg.scheduleAt = savedSchedule ?? cfg.scheduleAt;
  const savedJitterRaw = store.getSetting("schedule_jitter_min");
  const savedJitter = savedJitterRaw === null ? NaN : Number(savedJitterRaw);
  if (Number.isFinite(savedJitter) && savedJitter >= 0) cfg.scheduleJitterMin = savedJitter;
  const savedTz = store.getSetting("tz");
  if (savedTz?.trim()) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: savedTz.trim() }).format();
      cfg.tz = savedTz.trim();
    } catch {
      // Keep the environment value when a manually edited setting is invalid.
    }
  }

  const llm = createLLM(cfg, store);
  const launcher = createLauncher(llm.stagehand());
  const hh = createHHClient({ snapshotDir: paths.snapshots(cfg) });
  const habr = createHabrClient();
  const career = createCareerAgent(llm);

  const notifier = createTelegram(cfg.tgBotToken, cfg.tgChatId, cfg.panelUrl, { tz: cfg.tz, warn, fetch: telegramFetch() });
  const runner = createRunner({ cfg, store, launcher, hh, habr, career, llm, notifier, resume, loadCookies });
  const startedAt = new Date();
  const always = opts.withScheduler ? createAppAgent({ cfg, store, launcher, loadCookies, hh, habr, llm, notifier, runner, owed: () => ctx.scheduler?.owed() ?? false /* lazy: serve may replace the scheduler */, startedAt }) : null;
  const scheduler =
    opts.withScheduler && cfg.scheduleAt && cfg.runnerEnabled ? createScheduler(runner, { at: cfg.scheduleAt, tz: cfg.tz, jitterMin: cfg.scheduleJitterMin, log: warn }) : null;

  const ctx: AppContext = {
    cfg,
    store,
    notifier,
    llm,
    runner,
    scheduler,
    agent: always?.agent ?? null,
    chats: always?.chats ?? null,
    version: process.env.SGZ_VERSION ?? "dev",
    startedAt,
    async close(this: AppContext) {
      this.scheduler?.stop();
      const a = runner.active();
      if (a) await runner.stop(a.id);
      await Promise.all([runner.drain(), this.agent?.stop()]);
      store.close();
    },
  };
  return ctx;
}
