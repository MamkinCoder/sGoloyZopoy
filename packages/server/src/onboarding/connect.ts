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

/** Selectors of the login screens, recorded from the live pages in 2026-10. */
const HH = {
  submit: "[data-qa=submit-button]",
  credEmail: "[data-qa=credential-type-email]",
  emailInput: "[data-qa=applicant-login-input-email]",
  phoneInput: "[data-qa=magritte-phone-input-national-number-input]",
  codeInput: '[data-sgz-code="1"]',
} as const;
const HABR = { email: "input[name=email]", password: "input[name=password]" } as const;

/** «8 900 111-22-33», «900…», «+375 29 …» → «+7900…» / «+375…»; hh's phone field splits the country code by itself. */
export const normalizePhone = (raw: string): string => {
  const d = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) return `+${d}`;
  if (d.length === 11 && d.startsWith("8")) return `+7${d.slice(1)}`;
  return d.length === 10 ? `+7${d}` : `+${d}`;
};

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
  const wait = async (s: BrowserSession, sel: string, what: string, ms = 15_000): Promise<void> => {
    if (!(await s.waitForSelector(sel, ms))) {
      await s.snapshot(`onboard-${what}`).catch(() => "");
      throw new Error(`на странице входа нет «${what}»`);
    }
  };
  const pageSays = async (s: BrowserSession, re: RegExp, ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) if (await s.evaluate<boolean>(`${re}.test(document.body.innerText)`).catch(() => false)) return true;
    return false;
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
          // Recorded 2026-10: screen 1 = account type («Соискатель» preselected) + «Войти»; screen 2 = phone / e-mail + «Дальше».
          await s.goto(loginUrl());
          await wait(s, HH.submit, "кнопка «Войти»", 20_000);
          await s.click(HH.submit);
          const email = identifier.includes("@");
          if (email) {
            await wait(s, HH.credEmail, "выбор «Почта»");
            await s.click(HH.credEmail);
            await wait(s, HH.emailInput, "поле почты");
            await s.fill(HH.emailInput, identifier);
          } else {
            await wait(s, HH.phoneInput, "поле телефона");
            await s.fill(HH.phoneInput, normalizePhone(identifier)); // the page splits +375… into country code and number itself
          }
          await s.click(HH.submit);
          if (!(await pageSays(s, /код/i, 20_000))) {
            await s.snapshot("onboard-hh-no-code").catch(() => "");
            throw new Error("hh.ru не прислал код (проверь номер; возможно, нужна капча)");
          }
        } else {
          // Habr: one form at account.habr.com (reached through career.habr.com): e-mail + password.
          await s.goto("https://career.habr.com/users/auth/tmid");
          await wait(s, HABR.email, "поле e-mail", 20_000);
          await s.fill(HABR.email, identifier);
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
          // The code field has no recorded selector: the first visible text input that is not the phone / e-mail one.
          const tagged = await l.s.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll("input")].find((i) => !["hidden", "radio", "checkbox"].includes(i.type) && i.offsetParent !== null && !/phone-input|login-input-email|credential/.test(i.getAttribute("data-qa") || "")); if (!el) return false; el.setAttribute("data-sgz-code", "1"); return true; })()`);
          if (!tagged) throw new Error("на странице нет поля для кода");
          await l.s.fill(HH.codeInput, secret);
          await new Promise((r) => setTimeout(r, 2500)); // a six-digit code usually submits itself
          if (!(await hh.checkLogin(l.s)) && (await l.s.exists(HH.submit))) await l.s.click(HH.submit).catch(() => undefined);
          for (let i = 0; i < 10 && !(await hh.checkLogin(l.s)); i++) await new Promise((r) => setTimeout(r, 2000));
          if (!(await hh.checkLogin(l.s))) return false;
          await save(paths.cookies(cfg, slug), (await l.s.cookies()).filter((c) => HH_COOKIE.test(c.domain.replace(/^\./, ""))));
        } else {
          await wait(l.s, HABR.password, "поле пароля");
          await l.s.fill(HABR.password, secret);
          // fill() does not focus the field, so a bare Enter goes nowhere: press the form's own «Войти» button.
          await l.s.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(HABR.password)}).form; const b = [...f.querySelectorAll("button, input[type=submit]")].find((x) => /войти/i.test(x.textContent || x.value || "")); if (b) b.click(); else f.requestSubmit(); })()`);
          for (let i = 0; i < 20 && /account\.habr\.com/.test(await l.s.url().catch(() => "")); i++) await new Promise((r) => setTimeout(r, 1000));
          if (/account\.habr\.com/.test(await l.s.url().catch(() => ""))) {
            // Still on the login form: say what Habr says (wrong password, captcha, a code) instead of guessing.
            const said = await l.s.evaluate<string>(`(() => { const e = [...document.querySelectorAll("[class*=error], [class*=alert], [class*=flash], [class*=invalid], [role=alert]")].map((x) => (x.textContent || "").trim()).filter(Boolean)[0]; return (e || document.body.innerText.replace(/\\s+/g, " ")).slice(0, 220); })()`).catch(() => "");
            await l.s.snapshot("onboard-habr-login-failed").catch(() => "");
            if (/капч|анти-робот/i.test(said)) throw new Error("Пароль, скорее всего, верный: Хабр просит пройти капчу, а бот её пройти не может. Напиши «пропустить», Хабр подключим другим способом");
            throw new Error(`Хабр не пустил: «${said}»`);
          }
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
