// Interactive login: headed browser, the human logs in, we poll until the session is authenticated,
// then persist *.hh.ru cookies to a 0600 JSON file (also kept in the persistent chrome profile).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserLauncher, BrowserOptions, Cookie } from "@sgz/shared";
import { createHHClient } from "./client.js";
import { SEL } from "./selectors.js";
import { isLoginUrl, loginUrl } from "./urls.js";

export interface LoginOptions extends BrowserOptions {
  pollMs?: number; // default 2000
  timeoutMs?: number; // default 10 min
  log?: (msg: string) => void;
}

const isHHCookie = (c: Cookie): boolean => /(^|\.)hh\.ru$/i.test(c.domain.replace(/^\./, ""));

export const loginInteractive = async (launcher: BrowserLauncher, opts: LoginOptions, cookiesOut: string): Promise<Cookie[]> => {
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const log = opts.log ?? ((m: string) => console.log(m));
  const client = createHHClient({ snapshotDir: opts.snapshotDir });
  const s = await launcher.launch({ ...opts, headless: false, blockAssets: false });
  try {
    await s.goto(loginUrl());
    log("Войдите в hh.ru в открывшемся окне браузера. Жду до 10 минут…");
    const deadline = Date.now() + timeoutMs;
    let loggedIn = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const url = await s.url().catch(() => "");
      if (!url || isLoginUrl(url)) continue;
      // Left the login pages: verify cheaply first, then with the real check.
      let marker = false;
      for (const sel of SEL.login.loggedInMarker) if (await s.exists(sel).catch(() => false)) marker = true;
      if (marker || (await client.checkLogin(s))) {
        loggedIn = true;
        break;
      }
      await s.goto(loginUrl()).catch(() => {});
    }
    if (!loggedIn) throw new Error("login timed out: the session never became authenticated");
    const cookies = (await s.cookies()).filter(isHHCookie);
    if (!cookies.length) throw new Error("logged in but no *.hh.ru cookies were returned");
    await mkdir(dirname(cookiesOut), { recursive: true });
    await writeFile(cookiesOut, JSON.stringify(cookies, null, 2), { encoding: "utf8", mode: 0o600 });
    log(`Сохранено ${cookies.length} cookies в ${cookiesOut}`);
    return cookies;
  } finally {
    await s.close().catch(() => {});
  }
};
