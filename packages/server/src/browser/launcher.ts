// Chromium launch + Stagehand.create with the injected LLM. One browser at a time.
// APIs used (see node_modules/@browserbasehq/stagehand/dist/index.d.mts):
//   localBrowser.launch(LocalBrowserLaunchOptions)  → StagehandBrowser  (spawns Chromium over CDP)
//   Stagehand.create({ browser, model: { generate }, selfHeal, logging, telemetry, domSettleTimeoutMs })
//   browser.context.pages() / newPage()
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import type { BrowserLauncher, BrowserOptions, BrowserSession, StagehandLLM } from "@sgz/shared";
import { adaptLLM } from "./adapter.js";
import { ActionCache } from "./cache.js";
import { installAssetBlocker } from "./cdp.js";
import { StagehandSession } from "./session.js";

const VIEWPORT = { width: 1366, height: 850 } as const;
const DISK_CACHE_BYTES = 50_000_000;
const DOM_SETTLE_MS = 3_000;

// Not included on purpose: --no-sandbox, --single-process (RAM/security), and --disable-extensions —
// Stagehand v4 IS a Chrome extension (Extensions.loadUnpacked over CDP), so disabling extensions kills it.
const CHROMIUM_ARGS: readonly string[] = [
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-sync",
  // The Pi's service env carries HTTPS_PROXY/ALL_PROXY (a foreign VPN exit, for Claude and Telegram);
  // Linux Chromium would honor it and hh.ru answers 451 to that exit. Browsing always goes direct.
  "--no-proxy-server",
  "--renderer-process-limit=2",
  "--lang=ru-RU",
  // Headless ignores --lang for navigator.languages / Accept-Language; this one it honours.
  "--accept-lang=ru-RU,ru,en-US,en",
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  // Headless reports an 800x600 screen under a 1366x850 window and no WebGL: two bot tells for reCAPTCHA v3 and co.
  `--screen-info={${VIEWPORT.width}x${VIEWPORT.height + 50}}`,
  "--enable-unsafe-swiftshader",
];

const XVFB = "/usr/bin/Xvfb";
const XVFB_DISPLAY = ":99";
let xvfbStarted: Promise<boolean> | undefined;

/** A visible (headful) Chrome needs a screen. On a Linux box without one (the Pi) this starts one virtual screen,
 * Xvfb, for the life of the process (systemd's control-group kill ends it with the service) and points DISPLAY at
 * it; Chrome inherits the env. False when there is no display and no Xvfb: the caller falls back to headless. */
export function ensureDisplay(): Promise<boolean> {
  if (process.platform !== "linux" || process.env.DISPLAY) return Promise.resolve(true);
  if (!existsSync(XVFB)) return Promise.resolve(false);
  xvfbStarted ??= (async () => {
    const child = spawn(XVFB, [XVFB_DISPLAY, "-screen", "0", `${VIEWPORT.width}x${VIEWPORT.height + 50}x24`, "-nolisten", "tcp"], { stdio: "ignore", detached: false });
    child.unref();
    let exited = false;
    child.once("exit", () => {
      exited = true;
      xvfbStarted = undefined; // gone: the next headful launch starts a new one
      if (process.env.DISPLAY === XVFB_DISPLAY) delete process.env.DISPLAY;
    });
    await sleep(1000); // Xvfb takes a moment to accept clients
    if (exited) return false;
    process.env.DISPLAY = XVFB_DISPLAY;
    return true;
  })();
  return xvfbStarted;
}

const desktopUA = new Map<string, string>();
/** The desktop user agent of this Chromium build, in Chrome's reduced form: headless says "HeadlessChrome" (a bot
 * tell sites read). Set as a launch flag, so navigator.userAgentData keeps the browser's own client hints. */
export function desktopUserAgent(executablePath: string | undefined): string {
  if (!executablePath) return "";
  let ua = desktopUA.get(executablePath);
  if (ua === undefined) {
    let major = "";
    try {
      major = /(\d+)\.\d+\.\d+\.\d+/.exec(execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000 }))?.[1] ?? "";
    } catch {
      // unknown build: keep Chromium's own user agent
    }
    // Chrome's reduced UA: fixed platform tokens (x86_64 even on the Pi's arm64, 10_15_7 on any macOS).
    const platform = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
    ua = major ? `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` : "";
    desktopUA.set(executablePath, ua);
  }
  return ua;
}

export function createLauncher(llm: StagehandLLM): BrowserLauncher {
  const generate = adaptLLM(llm);
  return {
    async launch(opts: BrowserOptions): Promise<BrowserSession> {
      const cleanup: (() => Promise<void> | void)[] = [];
      const diskCacheDir = await mkdtemp(join(tmpdir(), "sgz-chromium-cache-"));
      cleanup.push(() => rm(diskCacheDir, { recursive: true, force: true }));

      const browser = await localBrowser.launch({
        executablePath: opts.executablePath,
        userDataDir: opts.userDataDir,
        // Headful needs a screen: a virtual one on the Pi, else headless as before.
        headless: opts.headless || !(await ensureDisplay()),
        args: [
          ...CHROMIUM_ARGS,
          // Nothing we parse or click needs pixels (Stagehand reads the DOM/a11y tree); images only cost the Pi time.
          // Sends keep them (loadImages): a browser that never loads an image is a bot tell for form spam filters.
          ...(opts.loadImages ? [] : ["--blink-settings=imagesEnabled=false"]),
          ...((opts.userAgent || desktopUserAgent(opts.executablePath)) ? [`--user-agent=${opts.userAgent || desktopUserAgent(opts.executablePath)}`] : []),
          `--disk-cache-dir=${diskCacheDir}`,
          `--disk-cache-size=${DISK_CACHE_BYTES}`,
        ],
        viewport: { ...VIEWPORT },
      });

      let stagehand: Stagehand;
      try {
        stagehand = await Stagehand.create({
          browser,
          model: { generate },
          selfHeal: false, // replay failures are handled by our cache → observe fallback, not by hidden LLM calls
          domSettleTimeoutMs: DOM_SETTLE_MS,
          logging: { level: "error", format: "pretty" },
          // The extension ships an OTLP exporter aimed at example.com; keep the Pi quiet.
          telemetry: { traces: { endpoint: "http://127.0.0.1:9/v1/traces", headers: {} } },
        });
      } catch (err) {
        await browser.close().catch(() => undefined);
        await Promise.allSettled(cleanup.map((fn) => fn()));
        throw err;
      }

      const pages = await browser.context.pages();
      const page = pages[0] ?? (await browser.context.newPage());

      if (opts.blockAssets) {
        const wsUrl = stagehand.rpcClient?.browserWebSocketDebuggerUrl;
        if (wsUrl) {
          try {
            cleanup.push(await installAssetBlocker(wsUrl, { images: !!opts.loadImages }));
          } catch {
            // blocking is an optimisation; keep going without it
          }
        }
      }

      return new StagehandSession({
        stagehand,
        browser,
        page,
        opts,
        cache: new ActionCache(opts.cacheDir),
        cleanup,
      });
    },
  };
}
