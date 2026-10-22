// Logging in to hh.ru and Habr Career from a Telegram chat. A headless Chrome on the seeker's own profile is driven
// with natural-language act() steps (no selectors recorded for these screens yet); secrets go through act's
// `variables`, so they never reach the model. The session lives between messages (hh: the SMS/e-mail code arrives
// after the first step) and is closed after SESSION_MS or when finished. One Chrome at a time (Pi memory): a mutex.
// Cookies are saved where the runs read them (paths.cookies / paths.habrCookies).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errMessage, paths, type BrowserLauncher, type BrowserSession, type Config, type Cookie, type Profile } from "@sgz/shared";
import { createHabrClient } from "../habr/client.js";
import { createHHClient } from "../hh/index.js";
import { loginUrl } from "../hh/urls.js";
import { readMemAvailableMB } from "../runner/budget.js";

const SESSION_MS = 5 * 60_000;
const HH_COOKIE = /(^|\.)hh\.ru$/i;
const HABR_COOKIE = /(^|\.)habr\.com$/i;

export type Site = "hh" | "habr";

export interface Connector {
  /** Opens the login and enters the identifier (hh: phone / e-mail → a code is sent; habr: e-mail). Throws a message fit for the user. */
  begin(site: Site, slug: string, identifier: string): Promise<void>;
  /** hh: the code; habr: the password. True when the session is authenticated and its cookies are saved. */
  finish(site: Site, slug: string, secret: string): Promise<boolean>;
  /** Waits for the Chrome slot, then runs `fn` (anything that launches its own Chrome). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** `exclusive` + a Chrome on the seeker's profile that is checked to be logged in to hh.ru. */
  withHh<T>(slug: string, fn: (s: BrowserSession) => Promise<T>): Promise<T>;
}

export function createConnector(cfg: Config, launcher: BrowserLauncher): Connector {
  const hh = createHHClient({ snapshotDir: paths.snapshots(cfg) });
  const habr = createHabrClient();
  let tail: Promise<void> = Promise.resolve();
  /** Serial section: resolves to its release function. */
  const lock = async (): Promise<() => void> => {
    let release!: () => void;
    const prev = tail;
    tail = new Promise<void>((r) => (release = r));
    await prev;
    return release;
  };
  const open = (slug: string): Promise<BrowserSession> =>
    launcher.launch({ executablePath: cfg.chromiumBin, headless: true, userDataDir: paths.chromeProfile(cfg, slug), userAgent: cfg.userAgent || undefined, snapshotDir: paths.snapshots(cfg), blockAssets: false, cacheDir: paths.actionCache(cfg) });

  const live = new Map<string, { s: BrowserSession; release: () => void; timer: NodeJS.Timeout }>();
  const drop = async (key: string): Promise<void> => {
    const l = live.get(key);
    if (!l) return;
    live.delete(key);
    clearTimeout(l.timer);
    await l.s.close().catch(() => undefined);
    l.release();
  };
  const save = async (file: string, cookies: Cookie[]): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cookies, null, 2), { encoding: "utf8", mode: 0o600 });
  };
  const step = async (s: BrowserSession, instruction: string, variables: Record<string, string>, cacheKey: string): Promise<void> => {
    const r = await s.act(instruction, { cacheKey, variables });
    if (!r.success) throw new Error(r.message);
  };

  return {
    async begin(site, slug, identifier) {
      const key = `${site}:${slug}`;
      await drop(key);
      if (readMemAvailableMB() < cfg.memoryGuardMB) throw new Error("на сервере сейчас мало памяти, попробуй через несколько минут");
      const release = await lock();
      let s: BrowserSession | null = null;
      try {
        s = await open(slug);
        if (site === "hh") {
          await s.goto(loginUrl());
          await step(s, "Выбери вход по телефону или почте, введи %id% в поле и нажми кнопку «Дальше» / «Получить код»", { id: identifier }, "onboard.hh.id");
        } else {
          await s.goto("https://account.habr.com/login?consumer=career");
          await step(s, "Введи %email% в поле e-mail", { email: identifier }, "onboard.habr.email");
        }
      } catch (e) {
        await s?.close().catch(() => undefined);
        release();
        throw new Error(`не смог открыть вход на ${site === "hh" ? "hh.ru" : "Хабр Карьере"}: ${errMessage(e)}`);
      }
      live.set(key, { s, release, timer: setTimeout(() => void drop(key), SESSION_MS) });
    },

    async finish(site, slug, secret) {
      const key = `${site}:${slug}`;
      const l = live.get(key);
      if (!l) throw new Error("сессия входа закрылась по таймауту, начни подключение заново");
      try {
        if (site === "hh") {
          await step(l.s, "Введи код подтверждения %code% в поле для кода", { code: secret }, "onboard.hh.code");
          for (let i = 0; i < 10 && !(await hh.checkLogin(l.s)); i++) await new Promise((r) => setTimeout(r, 2000));
          if (!(await hh.checkLogin(l.s))) return false;
          await save(paths.cookies(cfg, slug), (await l.s.cookies()).filter((c) => HH_COOKIE.test(c.domain.replace(/^\./, ""))));
        } else {
          await step(l.s, "Введи пароль %password% в поле пароля и нажми «Войти»", { password: secret }, "onboard.habr.password");
          await l.s.goto("https://career.habr.com/");
          if (!(await habr.checkLogin(l.s))) return false;
          await save(paths.habrCookies(cfg, slug), (await l.s.cookies()).filter((c) => HABR_COOKIE.test(c.domain.replace(/^\./, ""))));
        }
        return true;
      } finally {
        await drop(key);
      }
    },

    async exclusive(fn) {
      const release = await lock();
      try {
        return await fn();
      } finally {
        release();
      }
    },

    async withHh(slug, fn) {
      return this.exclusive(async () => {
        const s = await open(slug);
        try {
          if (!(await hh.checkLogin(s))) throw new Error("hh.ru: вход не сохранился");
          return await fn(s);
        } finally {
          await s.close().catch(() => undefined);
        }
      });
    },
  };
}

/** A new hh account has no resume: walks hh's creation wizard with the data of the profile. True when a resume exists afterwards. */
export async function createHhResume(s: BrowserSession, profile: Profile, title: string, about: string, maxSteps = 14): Promise<boolean> {
  const hh = createHHClient({ snapshotDir: "" });
  if ((await hh.syncResumes(s)).length) return true;
  const data = [`Должность: ${title}`, `Зарплата от: ${profile.salary_from || "не указывать"}`, `Город: ${profile.city}`, `Навыки: ${profile.verified_skills.join(", ")}`, `О себе: ${about}`, `Опыт: ${profile.experience}`].join("\n");
  await s.goto("https://hh.ru/applicant/resumes/new");
  for (let i = 0; i < maxSteps; i++) {
    const r = await s.act("Это мастер создания резюме. Заполни видимые поля данными из %data% (только то, что там есть; необязательные без данных пропусти) и нажми кнопку продолжения или сохранения. Если резюме уже опубликовано, ничего не делай.", { cacheKey: "onboard.hh.resume", variables: { data } });
    if (!r.success || /published=true/.test(await s.url())) break;
  }
  return (await hh.syncResumes(s)).length > 0;
}
