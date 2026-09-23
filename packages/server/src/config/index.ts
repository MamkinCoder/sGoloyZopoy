// Runtime configuration: process env > data/.env > defaults. Workstream A.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "@sgz/shared";
import { paths } from "@sgz/shared";
import { loadEnvFile } from "./env.js";

export { parseEnvText } from "./env.js";
export { loadProfileYaml, saveProfileYaml } from "./profile.js";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DEFAULTS = {
  dataDir: "./data",
  bind: { host: "0.0.0.0", port: 3002 },
  claudeBin: "claude",
  xelatexBin: "xelatex",
  scheduleAt: "12:00",
  scheduleJitterMin: 20,
  tz: "Europe/Moscow",
  throttleMinMs: 8000,
  throttleMaxMs: 20000,
  memoryGuardMB: 450,
} as const;

export function parseBind(raw: string): { host: string; port: number } {
  const v = raw.trim();
  const d = DEFAULTS.bind;
  if (!v) return { ...d };
  if (/^\d+$/.test(v)) return { host: d.host, port: Number(v) };
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(v);
  if (!m) return { ...d };
  const host = (m[1] ?? "").replace(/^\[|\]$/g, "") || d.host;
  const port = m[2] ? Number(m[2]) : d.port;
  return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : d.port };
}

/** "8s" | "500ms" | "2m" | "8000" -> milliseconds. Non-parseable -> fallback. */
export function parseDurationMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(raw);
  if (!m) return fallback;
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "ms").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

function parseInt_(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function defaultChromiumBin(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (platform === "linux") return "/usr/bin/chromium";
  return "chromium";
}

/** Nearest ancestor of `from` (inclusive) containing CLAUDE.md, else `from`. */
export function findRepoDir(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "CLAUDE.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

function normalizeSchedule(raw: string | undefined): string {
  if (raw === undefined) return DEFAULTS.scheduleAt;
  const v = raw.trim();
  if (!v || ["off", "none", "false", "0"].includes(v.toLowerCase())) return "";
  return v;
}

/**
 * SGZ_DATA_DIR must come from the process env (or default): `${dataDir}/.env` is read after it is known,
 * and keys from that file never override already-set env. The file's values are written into `env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const dataDir = resolve(cwd, env.SGZ_DATA_DIR || DEFAULTS.dataDir);
  loadEnvFile(join(dataDir, ".env"), env);

  const bind = parseBind(env.SGZ_BIND ?? "");
  const panelHost = bind.host === "0.0.0.0" || bind.host === "::" ? "localhost" : bind.host;
  return {
    dataDir,
    repoDir: env.SGZ_REPO_DIR ? resolve(cwd, env.SGZ_REPO_DIR) : findRepoDir(cwd),
    bind,
    panelPassword: env.SGZ_PANEL_PASSWORD ?? "",
    panelUrl: (env.SGZ_PANEL_URL || `http://${panelHost}:${bind.port}`).replace(/\/+$/, ""),
    tgBotToken: env.TG_BOT_TOKEN ?? "",
    tgChatId: env.TG_CHAT_ID ?? "",
    chromiumBin: env.CHROMIUM_BIN || defaultChromiumBin(process.platform),
    claudeBin: env.CLAUDE_BIN || DEFAULTS.claudeBin,
    xelatexBin: env.XELATEX_BIN || DEFAULTS.xelatexBin,
    scheduleAt: normalizeSchedule(env.SGZ_SCHEDULE),
    scheduleJitterMin: parseInt_(env.SGZ_SCHEDULE_JITTER, DEFAULTS.scheduleJitterMin),
    tz: env.SGZ_TZ || DEFAULTS.tz,
    runnerEnabled: parseBool(env.SGZ_RUNNER, true),
    throttleMinMs: parseDurationMs(env.SGZ_THROTTLE_MIN, DEFAULTS.throttleMinMs),
    throttleMaxMs: parseDurationMs(env.SGZ_THROTTLE_MAX, DEFAULTS.throttleMaxMs),
    userAgent: env.SGZ_USER_AGENT || DEFAULT_USER_AGENT,
    memoryGuardMB: parseInt_(env.SGZ_MEMORY_GUARD_MB, DEFAULTS.memoryGuardMB),
  };
}

/** Creates the data dir layout everything else assumes exists. */
export function ensureDirs(c: Config): void {
  for (const dir of [
    c.dataDir,
    `${c.dataDir}/users`,
    paths.snapshots(c),
    paths.actionCache(c),
    paths.recordings(c),
    paths.texDir(c),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
