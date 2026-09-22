// Records every step of the real hh flows into outDir (NN-step.html/.url/.state.json + png via
// session.snapshot) so fixtures can be built offline. Never submits a response, never sends a message.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserSession, HHClient, HHRecorder } from "@sgz/shared";
import { SEL, TEXT } from "./selectors.js";
import { extractInitialState } from "./state.js";
import { negotiationsUrl, resumesUrl, vacancyUrl } from "./urls.js";

export const createHHRecorder = (client: HHClient): HHRecorder => {
  const makeStepper = (outDir: string) => {
    let n = 0;
    return async (s: BrowserSession, step: string): Promise<void> => {
      n += 1;
      const base = join(outDir, `${String(n).padStart(2, "0")}-${step}`);
      await mkdir(outDir, { recursive: true });
      const html = await s.html();
      const url = await s.url();
      const state = extractInitialState(html);
      await writeFile(`${base}.html`, html, "utf8");
      await writeFile(`${base}.url`, url, "utf8");
      await writeFile(`${base}.state.json`, state ? JSON.stringify(state, null, 2) : "null", "utf8");
      await s.snapshot(`rec-${String(n).padStart(2, "0")}-${step}`).catch(() => "");
    };
  };

  const firstExisting = async (s: BrowserSession, candidates: readonly string[]): Promise<string | null> => {
    for (const sel of candidates) if (await s.exists(sel)) return sel;
    return null;
  };

  const recordVacancyFlow: HHRecorder["recordVacancyFlow"] = async (s, urlOrId, outDir) => {
    const rec = makeStepper(outDir);
    await s.goto(vacancyUrl(urlOrId));
    await client.assertNotBlocked(s);
    await rec(s, "vacancy");
    if (await s.exists(SEL.vacancy.alreadyApplied)) {
      await rec(s, "vacancy-already-applied");
      return;
    }
    if (await s.exists(SEL.vacancy.testMarker)) {
      await rec(s, "vacancy-has-test");
      return;
    }
    // WARNING: on accounts with a single resume hh may send the response right here (no popup).
    if (await s.exists(SEL.vacancy.respondTop)) await s.click(SEL.vacancy.respondTop);
    else await s.act("Нажми кнопку «Откликнуться» на вакансии", { cacheKey: "hh.apply.open_popup" });
    await new Promise((r) => setTimeout(r, 1500));
    await rec(s, "after-respond-click");
    if (await firstExisting(s, SEL.apply.otherCountryPopup)) {
      await rec(s, "other-country-popup");
      await s.pressEscape();
      return;
    }
    const toggle = await firstExisting(s, SEL.apply.letterToggle);
    if (toggle) {
      await s.click(toggle);
      await rec(s, "letter-open");
    } else if ((await s.text(8000)).includes(TEXT.letterToggle)) {
      await s.act("Нажми на «Сопроводительное письмо», чтобы раскрыть поле для текста письма", { cacheKey: "hh.apply.letter_toggle" });
      await rec(s, "letter-open");
    }
    if (await firstExisting(s, SEL.apply.questionnaire)) await rec(s, "questionnaire");
    await s.pressEscape();
    await rec(s, "after-escape");
  };

  const recordNegotiations: HHRecorder["recordNegotiations"] = async (s, negotiationId, outDir) => {
    const rec = makeStepper(outDir);
    await s.goto(negotiationsUrl());
    await client.assertNotBlocked(s);
    await rec(s, "negotiations");
    await s.goto(negotiationsUrl({ onlyUnread: true }));
    await rec(s, "negotiations-unread");
    if (negotiationId) {
      const threads = await client.listThreads(s, false);
      const t = threads.find((x) => x.negotiationId === negotiationId);
      await s.goto(t?.chatUrl ?? `https://hh.ru/applicant/negotiations/item?id=${negotiationId}`);
      await client.assertNotBlocked(s);
      await rec(s, `chat-${negotiationId}`);
    }
  };

  const recordResumes: HHRecorder["recordResumes"] = async (s, outDir) => {
    const rec = makeStepper(outDir);
    await s.goto(resumesUrl());
    await client.assertNotBlocked(s);
    await rec(s, "resumes");
    const resumes = await client.syncResumes(s);
    const first = resumes[0];
    if (first) {
      await s.goto(first.url);
      await rec(s, "resume-view");
    }
  };

  return { recordVacancyFlow, recordNegotiations, recordResumes };
};
