// Real wiring of the onboarding conversation (flow.ts): persistence, hh/Habr resume steps, the browser connector.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@sgz/shared";
import type { AppContext } from "../app.js";
import { habrResume } from "../commands/habr-resume.js";
import { saveProfileYaml } from "../config/profile.js";
import { renderProposal, type HabrResumeProposal } from "../habr/resume.js";
import { importProfile } from "../kb/write.js";
import { saveCV } from "../resume/yaml.js";
import { pdfText } from "./build.js";
import { createConnector, createHhResume } from "./connect.js";
import { createOnboarding } from "./flow.js";

export function wireOnboarding(app: AppContext) {
  const { cfg, store } = app;
  const connector = createConnector(cfg, app.launcher);
  return createOnboarding({
    store,
    llm: app.llm,
    notifier: app.notifier,
    connector,
    pdfText,
    now: () => new Date(),
    save(user, { profile, cv }) {
      store.saveProfile(user.id, profile);
      importProfile(store, user.id, profile); // knowledge-base tags, so «yes» answers in employer chats follow the skills
      saveProfileYaml(paths.profile(cfg, user.slug), profile);
      // A base CV only when there was a real CV to read; without jobs there is nothing for /cv to tailor.
      if (cv.jobs.length) saveCV(join(paths.cvDir(cfg, user.slug), `base-${profile.directions[0] ?? "other"}.yaml`), cv);
    },
    async prepareHh(user) {
      const profile = store.getProfile(user.id);
      if (!profile) throw new Error("нет профиля");
      const title = profile.extra.target_role || profile.directions[0] || "Разработчик";
      const made = await connector.withHh(user.slug, (s) => createHhResume(s, profile, title, profile.summary));
      if (!made) throw new Error("мастер создания резюме на hh.ru не дошёл до конца");
      return "Резюме на hh.ru есть. Дальше я сам размножу его под нужные направления и начну откликаться.";
    },
    showHabr(user) {
      const out = paths.habrResumeProposal(cfg, user.slug);
      return existsSync(out) ? renderProposal((JSON.parse(readFileSync(out, "utf8")) as { proposal: HabrResumeProposal }).proposal, true) : null;
    },
    async proposeHabr(user) {
      await connector.exclusive(() => habrResume(["--user", user.slug]));
      const out = paths.habrResumeProposal(cfg, user.slug);
      if (!existsSync(out)) throw new Error("предложение не создано");
      const { proposal } = JSON.parse(readFileSync(out, "utf8")) as { proposal: HabrResumeProposal };
      return renderProposal(proposal, true);
    },
    habrLoggedIn: (user) => existsSync(paths.habrCookies(cfg, user.slug)),
    async applyHabr(user) {
      await connector.exclusive(() => habrResume(["--user", user.slug, "--apply"]));
    },
  });
}
