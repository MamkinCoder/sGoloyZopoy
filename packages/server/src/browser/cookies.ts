// Cookie jar file IO (data/users/<slug>/hh-cookies.json) and small cookie helpers.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Cookie } from "@sgz/shared";

export async function loadCookies(path: string): Promise<Cookie[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.cookies) ? parsed.cookies : [];
  return list.filter(isCookieLike).map(normalize);
}

/** Writes atomically with mode 0600 — the jar is a login session. */
export async function saveCookies(path: string, cookies: Cookie[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cookies, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** Desktop Chrome UA; the Pi's chromium would otherwise announce "HeadlessChrome" and Linux armv8. */
export function defaultUserAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
}

/** Cookies whose domain is `suffix` or a subdomain of it (leading dots ignored). */
export function filterDomain(cookies: Cookie[], suffix: string): Cookie[] {
  const want = suffix.replace(/^\./, "").toLowerCase();
  return cookies.filter((c) => {
    const d = c.domain.replace(/^\./, "").toLowerCase();
    return d === want || d.endsWith(`.${want}`);
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isCookieLike = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && typeof v.name === "string" && typeof v.value === "string";

function normalize(c: Record<string, unknown>): Cookie {
  const sameSite = c.sameSite;
  return {
    name: String(c.name),
    value: String(c.value),
    domain: typeof c.domain === "string" ? c.domain : "",
    path: typeof c.path === "string" ? c.path : "/",
    expires: typeof c.expires === "number" ? c.expires : -1,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    ...(sameSite === "Strict" || sameSite === "Lax" || sameSite === "None" ? { sameSite } : {}),
  };
}
