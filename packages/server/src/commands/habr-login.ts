// sgz habr-login --user slug [--bin path]
// Headed Chrome: the human logs in to Habr Career, presses Enter; *.habr.com cookies go to
// data/users/<slug>/habr-cookies.json. Then every page the human opens is recorded (html, url, png) into
// data/recordings/habr-<slug>-<stamp>/ until Enter again, so the Habr flows can be automated offline.
// Nothing is clicked or submitted by the script.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
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
  if (!slug) throw new Error("usage: sgz habr-login --user <slug> [--bin <chrome path>]");
  const base = dataDir();
  const userDir = join(base, "users", slug);
  const outDir = join(base, "recordings", `habr-${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const s = await loadLauncher().launch({
    executablePath: chromiumBin(str(a.bin)),
    headless: false,
    userDataDir: join(userDir, "chrome-profile-habr"),
    userAgent: userAgent(),
    snapshotDir: outDir,
    blockAssets: false,
    cacheDir: join(base, "action-cache"),
  });
  try {
    await s.goto("https://career.habr.com/");
    await rl.question("1) Войдите в Habr Career в открывшемся окне (кнопка «Войти»). Когда увидите свой аккаунт, нажмите Enter здесь… ");
    const cookies = (await s.cookies()).filter(isHabrCookie);
    if (!cookies.length) throw new Error("no *.habr.com cookies: login did not complete");
    const cookiesOut = join(userDir, "habr-cookies.json");
    await mkdir(userDir, { recursive: true });
    await writeFile(cookiesOut, JSON.stringify(cookies, null, 2), { encoding: "utf8", mode: 0o600 });
    console.log(`Сохранено ${cookies.length} cookies в ${cookiesOut}\n`);

    console.log("2) Теперь откройте в том же окне по очереди (каждая страница записывается сама):");
    PAGES_TO_OPEN.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));
    console.log("   Когда закончите, нажмите Enter здесь.\n");
    await mkdir(outDir, { recursive: true });
    let n = 0;
    let last = "";
    let lastLen = 0;
    let done = false;
    const finished = rl.question("").then(() => (done = true));
    const save = async (url: string, html: string) => {
      n++;
      const name = `${String(n).padStart(2, "0")}-${new URL(url).pathname.replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || "root"}`;
      await writeFile(join(outDir, `${name}.url`), url, "utf8");
      await writeFile(join(outDir, `${name}.html`), html, "utf8");
      await s.snapshot(name).catch(() => "");
      console.log(`   записано: ${url}`);
    };
    while (!done) {
      const url = await s.url().catch(() => "");
      if (url && !url.startsWith("about:")) {
        if (url !== last) await new Promise((r) => setTimeout(r, 2500)); // let client-rendered pages settle
        const html = await s.html().catch(() => "");
        // A new page, or the same page changed a lot (the response dialog opens without a URL change).
        if (url !== last || Math.abs(html.length - lastLen) > 3000) {
          last = url;
          lastLen = html.length;
          await save(url, html);
        }
      }
      await Promise.race([finished, new Promise((r) => setTimeout(r, 2000))]);
    }
    await writeFile(cookiesOut, JSON.stringify((await s.cookies()).filter(isHabrCookie), null, 2), { encoding: "utf8", mode: 0o600 });
    console.log(`\nГотово: ${n} страниц в ${outDir}`);
  } finally {
    rl.close();
    await s.close().catch(() => {});
  }
};
