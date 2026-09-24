// Per-run state shared by all stages: logger, abort signal, throttle, the single browser handle.
import { existsSync, readFileSync } from "node:fs";
import { paths, RunAbortError, Status, type BrowserSession, type Config, type Cookie, type HHClient, type LLMClient, type Logger, type Run, type RunRequest, type Store, type User } from "@sgz/shared";
import { createThrottle, guardMemory, readMemAvailableMB, type Throttle } from "./budget.js";
import type { RunnerDeps } from "./deps.js";
import { RunStoppedError, errMessage, sleep as defaultSleep } from "./util.js";

export interface BrowserHandle {
  /** Launch (if needed) with the user's persistent profile and verify the hh login. */
  openHH(user: User): Promise<BrowserSession>;
  /** Same browser and profile, Habr Career login verified (habr cookies injected when needed). */
  openHabr(user: User): Promise<BrowserSession>;
  /** Launch (if needed) without any login check (career sites). */
  open(user: User): Promise<BrowserSession>;
  close(): Promise<void>;
}

export interface RunContext {
  deps: RunnerDeps;
  cfg: Config;
  store: Store;
  hh: HHClient;
  llm: LLMClient;
  run: Run;
  req: RunRequest;
  log: Logger;
  signal: AbortSignal;
  now(): Date;
  /** Throws RunStoppedError once stop() was requested. Called between items. */
  checkAbort(): void;
  throttle: Throttle;
  browser: BrowserHandle;
  memoryGuard(stage: string): Promise<void>;
  fileExists(path: string): boolean;
}

export function createContext(deps: RunnerDeps, run: Run, req: RunRequest, log: Logger, signal: AbortSignal): RunContext {
  const now = deps.now ?? (() => new Date());
  const sleepFn = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const mem = deps.memAvailableMB ?? readMemAvailableMB;
  const fileExists = deps.fileExists ?? existsSync;

  const checkAbort = () => {
    if (signal.aborted) throw new RunStoppedError();
  };
  const browser = createBrowserHandle(deps, { profileDir: paths.chromeProfile, snapshotDir: paths.snapshots(deps.cfg, run.id), log, checkAbort });

  return {
    deps,
    cfg: deps.cfg,
    store: deps.store,
    hh: deps.hh,
    llm: deps.llm.withRun(run.id),
    run,
    req,
    log,
    signal,
    now,
    checkAbort,
    throttle: createThrottle(deps.cfg, sleepFn, random, signal),
    browser,
    memoryGuard: (stage) => guardMemory(stage, { cfg: deps.cfg, memAvailableMB: mem, sleep: (ms) => sleepFn(ms, signal), closeBrowser: browser.close, log }),
    fileExists,
  };
}

export interface BrowserHandleOpts {
  /** Chrome profile per user: the runner's `chrome-profile`, the agent's `chrome-profile-chat`. */
  profileDir: (cfg: Config, slug: string) => string;
  snapshotDir: string;
  log: Logger;
  checkAbort?: () => void;
}

/** One lazily launched Chrome with the user's persistent profile; the hh / Habr login is verified on first use
 *  and the saved cookies are injected when the profile is logged out. Shared by runs and the always-on agent. */
export function createBrowserHandle(deps: Pick<RunnerDeps, "cfg" | "launcher" | "hh" | "habr" | "loadCookies">, o: BrowserHandleOpts): BrowserHandle {
  const { log } = o;
  const loadCookies = deps.loadCookies ?? defaultLoadCookies;
  let session: BrowserSession | null = null;
  let sessionSlug = "";
  let habrChecked: BrowserSession | null = null;

  const launch = async (user: User): Promise<BrowserSession> => {
    o.checkAbort?.();
    if (session && sessionSlug === user.slug) return session;
    if (session) await close();
    session = await deps.launcher.launch({
      executablePath: deps.cfg.chromiumBin,
      headless: true,
      userDataDir: o.profileDir(deps.cfg, user.slug),
      userAgent: deps.cfg.userAgent || undefined,
      snapshotDir: o.snapshotDir,
      blockAssets: true,
      cacheDir: paths.actionCache(deps.cfg),
    });
    sessionSlug = user.slug;
    log.info("session", `browser launched for ${user.slug}`);
    return session;
  };

  const close = async () => {
    const s = session;
    session = null;
    sessionSlug = "";
    if (!s) return;
    try {
      await s.close();
      log.info("session", "browser closed");
    } catch (e) {
      log.warn("session", `browser close failed: ${errMessage(e)}`);
    }
  };

  return {
    open: launch,
    async openHH(user) {
      const wasOpen = !!session && sessionSlug === user.slug;
      const s = await launch(user);
      if (wasOpen) return s;
      let ok = await deps.hh.checkLogin(s);
      if (!ok) {
        const cookies = await loadCookies(paths.cookies(deps.cfg, user.slug));
        if (cookies && cookies.length) {
          log.info("session", `not logged in, trying ${cookies.length} saved cookies`);
          await s.setCookies(cookies);
          ok = await deps.hh.checkLogin(s);
        }
      }
      if (!ok) throw new RunAbortError(Status.FAILED_LOGIN_EXPIRED, `hh.ru session for ${user.slug} is not authenticated; run \`sgz hh-login --user ${user.slug}\``);
      log.info("session", "hh login ok");
      return s;
    },
    async openHabr(user) {
      const s = await launch(user);
      if (habrChecked === s) return s;
      const habr = deps.habr;
      if (!habr) throw new Error("habr client is not configured");
      let ok = await habr.checkLogin(s);
      if (!ok) {
        const cookies = await loadCookies(paths.habrCookies(deps.cfg, user.slug));
        if (cookies && cookies.length) {
          log.info("session", `habr: not logged in, trying ${cookies.length} saved cookies`);
          await s.setCookies(cookies);
          ok = await habr.checkLogin(s);
        }
      }
      if (!ok) throw new RunAbortError(Status.FAILED_LOGIN_EXPIRED, `Habr Career session for ${user.slug} is not authenticated; run \`sgz habr-login --user ${user.slug}\``);
      habrChecked = s;
      log.info("session", "habr login ok");
      return s;
    },
    close,
  };
}

function defaultLoadCookies(p: string): Cookie[] | null {
  try {
    if (!existsSync(p)) return null;
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (Array.isArray(parsed)) return parsed as Cookie[];
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies)) return (parsed as { cookies: Cookie[] }).cookies;
    return null;
  } catch {
    return null;
  }
}
