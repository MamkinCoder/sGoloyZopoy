// Shared bits for the hh-* commands: arg parsing, data dir, browser launcher.
import { resolve } from "node:path";
import type { BrowserLauncher } from "@sgz/shared";
import { createLauncher } from "../browser/launcher.js";
import { loadConfig } from "../config/index.js";
import { createLLM } from "../llm/index.js";

const LINUX_CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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

export const loadLauncher = (): BrowserLauncher => createLauncher(createLLM(loadConfig(), null).stagehand());
