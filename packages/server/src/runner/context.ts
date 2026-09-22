// Per-run state shared by all stages: logger, abort signal, throttle, the single browser handle.
import { existsSync, readFileSync } from "node:fs";
import { paths, RunAbortError, Status, type BrowserSession, type Config, type Cookie, type HHClient, type LLMClient, type Logger, type Run, type RunRequest, type Store, type User } from "@sgz/shared";
import { createThrottle, guardMemory, readMemAvailableMB, type Throttle } from "./budget.js";
import type { RunnerDeps } from "./deps.js";
import { RunStoppedError, errMessage, sleep as defaultSleep } from "./util.js";

export interface BrowserHandle {
  current(): BrowserSession | null;
  /** Launch (if needed) with the user's persistent profile and verify the hh login. */
  openHH(user: User): Promise<BrowserSession>;
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
  sleep(ms: number): Promise<void>;
  fileExists(path: string): boolean;
}

export function createContext(deps: RunnerDeps, run: Run, req: RunRequest, log: Logger, signal: AbortSignal): RunContext {
  const now = deps.now ?? (() => new Date());
  const sleepFn = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const mem = deps.memAvailableMB ?? readMemAvailableMB;
  const fileExists = deps.fileExists ?? ((p: string) => defaultFileExists(p));
  const loadCookies = deps.loadCookies ?? defaultLoadCookies;

  const checkAbort = () => {
    if (signal.aborted) throw new RunStoppedError();
  };

  let session: BrowserSession | null = null;
  let sessionSlug = "";

  const launch = async (user: User): Promise<BrowserSession> => {
    checkAbort();
    if (session && sessionSlug === user.slug) return session;
    if (session) await close();
    session = await deps.launcher.launch({
      executablePath: deps.cfg.chromiumBin,
      headless: true,
      userDataDir: paths.chromeProfile(deps.cfg, user.slug),
      userAgent: deps.cfg.userAgent || undefined,
      snapshotDir: paths.snapshots(deps.cfg, run.id),
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

  const browser: BrowserHandle = {
    current: () => session,
    open: launch,
    async openHH(user) {
      const wasOpen = !!session && sessionSlug === user.slug;
      const s = await launch(user);
      if (wasOpen) return s;
      let ok = await deps.hh.checkLogin(s);
      if (!ok) {
        const cookies = loadCookies(paths.cookies(deps.cfg, user.slug));
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
    close,
  };

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
    memoryGuard: (stage) => guardMemory(stage, { cfg: deps.cfg, memAvailableMB: mem, sleep: (ms) => sleepFn(ms, signal), closeBrowser: close, log }),
    sleep: (ms) => sleepFn(ms, signal),
    fileExists,
  };
}

function defaultFileExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
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
