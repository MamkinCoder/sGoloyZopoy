// Minimal dotenv: KEY=VALUE lines, # comments, optional quotes. Never overrides keys already set.
import { existsSync, readFileSync } from "node:fs";

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Loads `path` into `env` for keys that are unset. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseEnvText(readFileSync(path, "utf8")))) env[k] ??= v;
}
