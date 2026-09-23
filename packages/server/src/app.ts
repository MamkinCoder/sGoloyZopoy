// Composition root: config, store, LLM, browser, hh, career, resume, notifier, runner, scheduler.
import type { Config, Notifier, Store } from "@sgz/shared";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "@sgz/shared";
import { createLauncher, loadCookies } from "./browser/index.js";
import { createCareerAgent } from "./career/index.js";
import { ensureDirs, loadConfig } from "./config/index.js";
import { openStore, seedDefaultUsers } from "./db/index.js";
import { createHHClient } from "./hh/index.js";
import { createLLM } from "./llm/index.js";
import { telegramFetch } from "./notify/proxy.js";
import { createTelegram } from "./notify/telegram.js";
import { buildPdf, loadCV, renderTex, resolveLatexBin, validateCV } from "./resume/index.js";
import { createRunner, type Runner } from "./runner/service.js";
import type { ResumeDeps } from "./runner/deps.js";
import { createScheduler, type Scheduler } from "./scheduler/index.js";

export interface AppContext {
  cfg: Config;
  store: Store;
  notifier: Notifier;
  runner: Runner;
  scheduler: Scheduler | null;
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
  const career = createCareerAgent(llm);

  const notifier = createTelegram(cfg.tgBotToken, cfg.tgChatId, cfg.panelUrl, { tz: cfg.tz, warn, fetch: telegramFetch() });
  const runner = createRunner({ cfg, store, launcher, hh, career, llm, notifier, resume, loadCookies });
  const scheduler =
    opts.withScheduler && cfg.scheduleAt && cfg.runnerEnabled ? createScheduler(runner, { at: cfg.scheduleAt, tz: cfg.tz, jitterMin: cfg.scheduleJitterMin, log: warn }) : null;

  return {
    cfg,
    store,
    notifier,
    runner,
    scheduler,
    version: process.env.SGZ_VERSION ?? "dev",
    startedAt: new Date(),
    async close(this: AppContext) {
      this.scheduler?.stop();
      const a = runner.active();
      if (a) {
        await runner.stop(a.id);
        await runner.drain();
      }
      store.close();
    },
  };
}
