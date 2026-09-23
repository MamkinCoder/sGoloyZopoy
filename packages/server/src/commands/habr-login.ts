// sgz habr-login --user slug [--bin path] [--minutes 30]
// Headed Chrome: the human logs in to Habr Career and clicks through their pages. Every page is recorded
// (html, url, png) into data/recordings/habr-<slug>-<stamp>/ and *.habr.com cookies are saved to
// data/users/<slug>/habr-cookies.json as they change. Closing the window ends it; no terminal input
// needed (works from `!` in Claude Code). Nothing is clicked or submitted by the script.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cookie } from "@sgz/shared";
import { chromiumBin, dataDir, loadLauncher, parseArgs, str, userAgent } from "./hh-common.js";

const isHabrCookie = (c: Cookie): boolean => /(^|\.)habr\.com$/i.test(c.domain.replace(/^\./, ""));

const PAGES_TO_OPEN = [
  "свой профиль / резюме на Habr Career (просмотр) и страницу его редактирования (все вкладки: о себе, опыт, навыки)",
  "любую вакансию и нажмите «Откликнуться» - дождитесь формы отклика, НЕ отправляйте",
  "список своих откликов",
  "сообщения / чаты с работодателями (откройте хотя бы один диалог)",
  "настройки уведомлений и поиска работы",
];

export const habrLogin = async (args: string[]): Promise<void> => {
  const a = parseArgs(args);
  const slug = str(a.user);
  if (!slug) throw new Error("usage: sgz habr-login --user <slug> [--bin <chrome path>] [--minutes 30]");
  const deadline = Date.now() + (Number(str(a.minutes)) || 30) * 60_000;
  const base = dataDir();
  const userDir = join(base, "users", slug);
  const outDir = join(base, "recordings", `habr-${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const s = await loadLauncher().launch({
    executablePath: chromiumBin(str(a.bin)),
    headless: false,
    userDataDir: join(userDir, "chrome-profile-habr"),
    userAgent: userAgent(),
    snapshotDir: outDir,
    blockAssets: false,
    cacheDir: join(base, "action-cache"),
  });
  const cookiesOut = join(userDir, "habr-cookies.json");
  await mkdir(userDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  console.log("Войдите в Habr Career в открывшемся окне Chrome, затем откройте по очереди:");
  PAGES_TO_OPEN.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));
  console.log("Каждая страница записывается сама. Когда закончите - просто закройте окно Chrome.\n");
  let n = 0;
  let last = "";
  let lastLen = 0;
  let savedCookies = 0;
  const save = async (url: string, html: string) => {
    n++;
    const name = `${String(n).padStart(2, "0")}-${new URL(url).pathname.replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "root"}`;
    await writeFile(join(outDir, `${name}.url`), url, "utf8");
    await writeFile(join(outDir, `${name}.html`), html, "utf8");
    await s.snapshot(name).catch(() => "");
    console.log(`   записано: ${url}`);
  };
  try {
    await s.goto("https://career.habr.com/");
    while (Date.now() < deadline) {
      let url: string;
      try {
        url = await s.url();
      } catch {
        break; // window closed
      }
      if (url && !url.startsWith("about:")) {
        if (url !== last) await new Promise((r) => setTimeout(r, 2500)); // let client-rendered pages settle
        const html = await s.html().catch(() => "");
        // A new page, or the same page changed a lot (the response dialog opens without a URL change).
        if (url !== last || Math.abs(html.length - lastLen) > 3000) {
          last = url;
          lastLen = html.length;
          await save(url, html);
        }
        const cookies = (await s.cookies().catch(() => [] as Cookie[])).filter(isHabrCookie);
        if (cookies.length && cookies.length !== savedCookies) {
          await writeFile(cookiesOut, JSON.stringify(cookies, null, 2), { encoding: "utf8", mode: 0o600 });
          savedCookies = cookies.length;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`\nГотово: ${n} страниц в ${outDir}; cookies (${savedCookies}) в ${cookiesOut}`);
  } finally {
    await s.close().catch(() => {});
  }
};
