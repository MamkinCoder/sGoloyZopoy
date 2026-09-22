// Shared bits for the hh-* commands: arg parsing, data dir, lazy loading of other workstreams'
// modules (browser/launcher, llm, config) so this folder typechecks before they exist.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserLauncher, Config, Cookie, StagehandLLM } from "@sgz/shared";

export const LINUX_CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const parseArgs = (args: string[]): Record<string, string | true> => {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
};

export const str = (v: string | true | undefined): string => (typeof v === "string" ? v : "");

export const dataDir = (): string => resolve(process.env.SGZ_DATA_DIR ?? "./data");

export const chromiumBin = (flag: string): string =>
  flag || process.env.CHROMIUM_BIN || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium");

export const userAgent = (): string => process.env.SGZ_USER_AGENT || LINUX_CHROME_UA;

// Dynamic specifiers are built at runtime so tsc does not try to resolve modules other workstreams
// may not have written yet.
const lazy = async <T>(rel: string): Promise<T | null> => {
  try {
    const href = new URL(rel, import.meta.url).href;
    return (await import(href)) as T;
  } catch {
    return null;
  }
};

export const loadLauncher = async (): Promise<BrowserLauncher> => {
  const browser = await lazy<{ createLauncher: (llm: StagehandLLM) => BrowserLauncher }>("../browser/launcher.js");
  if (!browser?.createLauncher) throw new Error("browser/launcher.js is not available yet (workstream B)");
  return browser.createLauncher(await loadStagehandLLM());
};

const loadStagehandLLM = async (): Promise<StagehandLLM> => {
  const llm = await lazy<{ createLLM: (cfg: Config, store: null) => { stagehand(): StagehandLLM } }>("../llm/index.js");
  if (!llm?.createLLM) {
    // No LLM yet: deterministic helpers still work; act/extract will fail loudly.
    return { generate: async () => Promise.reject(new Error("llm/index.js is not available yet (workstream D)")) };
  }
  return llm.createLLM(await loadConfig(), null).stagehand();
};

export const loadConfig = async (): Promise<Config> => {
  for (const rel of ["../config/index.js", "../config/config.js"]) {
    const m = await lazy<{ loadConfig?: () => Config }>(rel);
    if (m?.loadConfig) return m.loadConfig();
  }
  return fallbackConfig();
};

const fallbackConfig = (): Config => ({
  dataDir: dataDir(),
  repoDir: process.cwd(),
  bind: { host: "0.0.0.0", port: 3002 },
  panelPassword: "",
  panelUrl: "",
  tgBotToken: "",
  tgChatId: "",
  chromiumBin: chromiumBin(""),
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  xelatexBin: "xelatex",
  scheduleAt: "",
  scheduleJitterMin: 20,
  tz: "Europe/Moscow",
  runnerEnabled: false,
  throttleMinMs: 8000,
  throttleMaxMs: 20000,
  userAgent: userAgent(),
  memoryGuardMB: 450,
});

export const readCookieFile = async (path: string): Promise<Cookie[]> => {
  const raw = await readFile(path, "utf8");
  const v: unknown = JSON.parse(raw);
  return Array.isArray(v) ? (v as Cookie[]) : [];
};
