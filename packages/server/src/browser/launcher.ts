// Chromium launch + Stagehand.create with the injected LLM. One browser at a time.
// APIs used (see node_modules/@browserbasehq/stagehand/dist/index.d.mts):
//   localBrowser.launch(LocalBrowserLaunchOptions)  → StagehandBrowser  (spawns Chromium over CDP)
//   Stagehand.create({ browser, model: { generate }, selfHeal, logging, telemetry, domSettleTimeoutMs })
//   browser.context.pages() / newPage()
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
  // Nothing we parse or click needs pixels (Stagehand reads the DOM/a11y tree); images only cost the Pi time.
  "--blink-settings=imagesEnabled=false",
  "--lang=ru-RU",
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
];

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
        headless: opts.headless,
        args: [
          ...CHROMIUM_ARGS,
          ...(opts.userAgent ? [`--user-agent=${opts.userAgent}`] : []),
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
            cleanup.push(await installAssetBlocker(wsUrl));
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
