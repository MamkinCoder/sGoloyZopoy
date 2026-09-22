// Session cookie: HMAC-SHA256(secret, issuedAt) + "." + issuedAt. The secret mixes the panel
// password with a per-process random salt, so restarting the server invalidates every session
// (acceptable: single-user panel, the login form is one field).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { unauthorized } from "./errors.js";

export const SESSION_COOKIE = "sgz_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

export interface AuthService {
  /** false when cfg.panelPassword is empty: the guard lets everything through (trusted LAN mode). */
  authRequired: boolean;
  issue(c: Context): void;
  clear(c: Context): void;
  verify(c: Context): boolean;
  checkPassword(candidate: string): boolean;
  /** Middleware: 401 unless the cookie verifies. */
  guard: MiddlewareHandler;
  /** Login rate limiter, in-memory per client IP. */
  limiter: { blocked(ip: string): boolean; fail(ip: string): void; reset(ip: string): void };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function clientIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "local";
}

export function createAuth(panelPassword: string): AuthService {
  const secret = createHmac("sha256", randomBytes(32)).update(panelPassword).digest();
  const sign = (issuedAt: string) => createHmac("sha256", secret).update(issuedAt).digest("hex");

  const failures = new Map<string, number[]>();
  const limiter = {
    blocked(ip: string) {
      const now = Date.now();
      const recent = (failures.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
      failures.set(ip, recent);
      return recent.length >= LOGIN_MAX_FAILURES;
    },
    fail(ip: string) {
      failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
    },
    reset(ip: string) {
      failures.delete(ip);
    },
  };

  const verify = (c: Context): boolean => {
    const raw = getCookie(c, SESSION_COOKIE);
    if (!raw) return false;
    const dot = raw.lastIndexOf(".");
    if (dot <= 0) return false;
    const sig = raw.slice(0, dot);
    const issuedAt = raw.slice(dot + 1);
    if (!/^\d+$/.test(issuedAt)) return false;
    const age = Date.now() - Number(issuedAt);
    if (age < 0 || age > SESSION_TTL_MS) return false;
    return safeEqual(sig, sign(issuedAt));
  };

  const authRequired = panelPassword.length > 0;
  const guard: MiddlewareHandler = async (c, next) => {
    if (authRequired && !verify(c)) throw unauthorized();
    await next();
  };

  return {
    authRequired,
    issue(c) {
      const issuedAt = String(Date.now());
      const secure = c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
      setCookie(c, SESSION_COOKIE, `${sign(issuedAt)}.${issuedAt}`, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
        secure,
      });
    },
    clear(c) {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    },
    verify,
    checkPassword: (candidate) => !authRequired || safeEqual(candidate, panelPassword),
    guard,
    limiter,
  };
}
