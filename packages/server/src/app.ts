// Composition root. Other workstreams' modules are loaded lazily by path and cast to the shared
// interfaces, so this file type-checks before those modules exist and fails loudly at runtime
// if one is missing.
import type { BrowserLauncher, CareerAgent, Config, Cookie, HHClient, LLMClient, Notifier, Store } from "@sgz/shared";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "@sgz/shared";
import { telegramFetch } from "./notify/proxy.js";
import { createTelegram } from "./notify/telegram.js";
import { createRunner, type Runner } from "./runner/service.js";
import type { ResumeDeps } from "./runner/deps.js";
import { createScheduler, type Scheduler } from "./scheduler/index.js";
import { resolveLatexBin } from "./resume/build.js";

export interface AppContext {
  cfg: Config;
  store: Store;
  llm: LLMClient;
  launcher: BrowserLauncher;
  hh: HHClient;
  career: CareerAgent | null;
  resume: ResumeDeps | null;
  notifier: Notifier;
  runner: Runner;
  scheduler: Scheduler | null;
  version: string;
  startedAt: Date;
  /** Missing optional modules (career, resume, api) with the reason. */
  missing: Record<string, string>;
  close(): Promise<void>;
}

export interface AppOptions {
  withScheduler?: boolean;
  quiet?: boolean;
}

type AnyModule = Record<string, unknown>;

/** import() with a non-literal specifier keeps tsc from resolving it at compile time. */
export async function loadModule(candidates: string[]): Promise<AnyModule | null> {
  let lastErr = "";
  for (const spec of candidates) {
    try {
      return (await import(spec)) as AnyModule;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = msg;
      const notFound = /Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load url/.test(msg) && msg.includes(spec.replace(/^\.\//, "").replace(/\.js$/, ""));
      if (!notFound) throw e;
    }
  }
  if (lastErr) return null;
  return null;
}

async function requireModule(name: string, candidates: string[]): Promise<AnyModule> {
  const m = await loadModule(candidates);
  if (!m) throw new Error(`module "${name}" is not available yet (tried ${candidates.join(", ")})`);
  return m;
}

function fn<T>(m: AnyModule, name: string, mod: string): T {
  const f = m[name];
  if (typeof f !== "function") throw new Error(`${mod} does not export ${name}()`);
  return f as T;
}

export async function createAppContext(opts: AppOptions = {}): Promise<AppContext> {
  const missing: Record<string, string> = {};
  const warn = opts.quiet ? () => undefined : (m: string) => console.error(m);

  const configMod = await requireModule("config", ["./config/index.js", "./config/config.js"]);
  const cfg = fn<() => Config>(configMod, "loadConfig", "config")();
  const ensureDirs = configMod.ensureDirs;
  if (typeof ensureDirs === "function") ensureDirs(cfg);

  const dbMod = await requireModule("db", ["./db/store.js", "./db/index.js"]);
  const store = fn<(path: string) => Store>(dbMod, "openStore", "db")(paths.db(cfg));
  const seed = dbMod.seedDefaultUsers;
  if (typeof seed === "function") seed(store);
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

  const llmMod = await requireModule("llm", ["./llm/index.js", "./llm/client.js"]);
  const llm = fn<(c: Config, s: Store | null) => LLMClient>(llmMod, "createLLM", "llm")(cfg, store);

  const browserMod = await requireModule("browser", ["./browser/index.js", "./browser/launcher.js"]);
  const launcher = fn<(l: unknown) => BrowserLauncher>(browserMod, "createLauncher", "browser")(llm.stagehand());
  const loadCookies = typeof browserMod.loadCookies === "function" ? (browserMod.loadCookies as (p: string) => Promise<Cookie[]>) : undefined;
  const defaultUA = typeof browserMod.defaultUserAgent === "function" ? (browserMod.defaultUserAgent as () => string)() : "";
  if (!cfg.userAgent && defaultUA) cfg.userAgent = defaultUA;

  const hhMod = await requireModule("hh", ["./hh/index.js", "./hh/client.js"]);
  const hh = fn<(o: { snapshotDir: string }) => HHClient>(hhMod, "createHHClient", "hh")({ snapshotDir: paths.snapshots(cfg) });

  let career: CareerAgent | null = null;
  const careerMod = await loadModule(["./career/index.js", "./career/agent.js"]);
  if (careerMod && typeof careerMod.createCareerAgent === "function") career = (careerMod.createCareerAgent as (l: LLMClient) => CareerAgent)(llm);
  else missing.career = "career/ not available: career sites are skipped";

  let resume: ResumeDeps | null = null;
  const resumeMod = await loadModule(["./resume/index.js"]);
  if (resumeMod && typeof resumeMod.loadCV === "function") resume = adaptResume(resumeMod);
  else missing.resume = "resume/ not available: career applies are skipped";
  for (const [k, v] of Object.entries(missing)) warn(`app: ${k}: ${v}`);

  const notifier = createTelegram(cfg.tgBotToken, cfg.tgChatId, cfg.panelUrl, { tz: cfg.tz, warn, fetch: telegramFetch() });
  const runner = createRunner({ cfg, store, launcher, hh, career, llm, notifier, resume, loadCookies });
  const scheduler =
    opts.withScheduler && cfg.scheduleAt && cfg.runnerEnabled ? createScheduler(runner, { at: cfg.scheduleAt, tz: cfg.tz, jitterMin: cfg.scheduleJitterMin, log: warn }) : null;

  return {
    cfg,
    store,
    llm,
    launcher,
    hh,
    career,
    resume,
    notifier,
    runner,
    scheduler,
    version: process.env.SGZ_VERSION ?? "dev",
    startedAt: new Date(),
    missing,
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

/** Bridges workstream E's exports (unknown exact signatures) to the runner's ResumeDeps. */
function adaptResume(m: AnyModule): ResumeDeps {
  const loadCV = m.loadCV as (p: string) => unknown;
  const renderTex = m.renderTex as (cv: unknown) => string;
  const buildPdf = m.buildPdf as (o: Record<string, unknown>) => unknown;
  const validateCV = m.validateCV as (b: unknown, t: unknown, n: string[]) => unknown;
  return {
    loadCV: async (p) => (await loadCV(p)) as ResumeDeps extends { loadCV: (p: string) => Promise<infer T> } ? T : never,
    renderTex: (cv) => renderTex(cv),
    async buildPdf(o) {
      const texPath = o.outPdf.replace(/\.pdf$/i, ".tex");
      await mkdir(dirname(texPath), { recursive: true });
      await writeFile(texPath, o.tex, "utf8");
      const r = (await buildPdf({ texSource: o.tex, texDir: o.texDir, outPdf: o.outPdf, latexBin: await resolveLatexBin(o.xelatexBin) })) as
        | string
        | { pdfPath?: string; texPath?: string; pdf?: string; tex?: string }
        | undefined;
      if (typeof r === "string") return { pdfPath: r, texPath };
      return { pdfPath: r?.pdfPath ?? r?.pdf ?? o.outPdf, texPath: r?.texPath ?? r?.tex ?? texPath };
    },
    validateCV(base, tailored, never) {
      const r = validateCV(base, tailored, never);
      if (Array.isArray(r)) return r.map(String);
      if (r && typeof r === "object") {
        const o = r as { ok?: boolean; violations?: unknown[]; errors?: unknown[] };
        if (o.ok === true) return [];
        return (o.violations ?? o.errors ?? []).map(String);
      }
      return r === false ? ["validation failed"] : [];
    },
  };
}
