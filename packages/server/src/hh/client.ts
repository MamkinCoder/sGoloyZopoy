// hh.ru flows over BrowserSession. Deterministic helpers + InitialState where markup is known;
// Stagehand act/extract (with stable cacheKeys) for everything fragile. Every failure path
// snapshots "<vacancyId>-<step>" and returns FAILED_UI; blocks throw RunAbortError.
import { z } from "zod";
import {
  type Answer,
  type ApplyRequest,
  type ApplyResult,
  type BrowserSession,
  type Card,
  type HHClient,
  type HHResume,
  type Question,
  type ResumeEdit,
  type SearchParams,
  type ThreadDetail,
  type Vacancy,
  RunAbortError,
  Status,
  normalizeDedup,
} from "@sgz/shared";
import { SEL, TEXT } from "./selectors.js";
import { asksQuestion, extractInitialState, get, parseChat, parseChatik, parseNegotiations, parseResumes, parseSearch, parseVacancy, type ParsedThread } from "./state.js";
import { parseSalary } from "./salary.js";
import { HH_ORIGIN, isCaptchaUrl, isLoginUrl, negotiationsUrl, resumeUrl, resumesUrl, searchUrl, vacancyIdFrom, vacancyUrl } from "./urls.js";

export interface HHClientOptions {
  snapshotDir: string;
  /** Pause after UI transitions (popup open etc.). Tests set 0. */
  settleMs?: number;
  /** Confirmation wait after submit. */
  confirmTimeoutMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const ExtractedQuestion = z.object({
  text: z.string(),
  kind: z.enum(["radio", "checkbox", "text", "select", "number", "file"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

const QuestionSchema = z.object({ questions: z.array(ExtractedQuestion) });

const ChatExtractSchema = z.object({
  employer: z.string().optional(),
  vacancyId: z.string().optional(),
  messages: z.array(z.object({ author: z.enum(["employer", "bot", "me"]), text: z.string() })),
  survey: z.array(ExtractedQuestion),
});

const toQuestion = (q: z.infer<typeof ExtractedQuestion>, idx: number): Question => ({
  idx,
  text: q.text,
  kind: q.kind,
  required: q.required ?? true,
  ...(q.options?.length ? { options: q.options } : {}),
});

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const norm = (u: string): string => u.replace(/[?#].*$/, "").replace(/\/+$/, "");

export const createHHClient = (opts: HHClientOptions): HHClient => {
  const settleMs = opts.settleMs ?? 600;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 10_000;
  const log = opts.log ?? (() => {});

  const firstExisting = async (s: BrowserSession, candidates: readonly string[]): Promise<string | null> => {
    for (const sel of candidates) if (await s.exists(sel)) return sel;
    return null;
  };
  const textHas = async (s: BrowserSession, needles: readonly string[], maxChars = 8000): Promise<string | null> => {
    const t = await s.text(maxChars);
    for (const n of needles) if (t.includes(n)) return n;
    return null;
  };

  const assertNotBlocked = async (s: BrowserSession): Promise<void> => {
    const url = await s.url();
    if (isCaptchaUrl(url)) throw new RunAbortError(Status.FAILED_CAPTCHA, `captcha page: ${url}`);
    if (isLoginUrl(url)) throw new RunAbortError(Status.FAILED_LOGIN_EXPIRED, `redirected to login: ${url}`);
    if (await firstExisting(s, SEL.login.form)) throw new RunAbortError(Status.FAILED_LOGIN_EXPIRED, `login form shown at ${url}`);
    if (await firstExisting(s, SEL.block.captchaMarker)) throw new RunAbortError(Status.FAILED_CAPTCHA, `captcha widget at ${url}`);
    const text = await s.text(6000);
    for (const n of TEXT.captcha) if (text.includes(n)) throw new RunAbortError(Status.FAILED_CAPTCHA, `captcha text «${n}» at ${url}`);
    for (const n of TEXT.antiBot) if (text.includes(n)) throw new RunAbortError(Status.FAILED_ANTI_BOT, `anti-bot text «${n}» at ${url}`);
  };

  const open = async (s: BrowserSession, url: string, quick = false): Promise<void> => {
    await s.goto(url, { quick });
    await assertNotBlocked(s);
  };
  const ensureAt = async (s: BrowserSession, url: string): Promise<void> => {
    if (norm(await s.url()) !== norm(url)) await open(s, url);
    else await assertNotBlocked(s);
  };

  const checkLogin = async (s: BrowserSession): Promise<boolean> => {
    try {
      await open(s, resumesUrl());
    } catch (e) {
      if (e instanceof RunAbortError && e.status === Status.FAILED_LOGIN_EXPIRED) return false;
      throw e;
    }
    return true;
  };

  // ------------------------------------------------------------ search

  const DOM_SEARCH_JS = `(() => {
    const items = Array.from(document.querySelectorAll(${JSON.stringify(SEL.search.item)}));
    return items.map((it) => {
      const a = it.querySelector(${JSON.stringify(SEL.search.title)});
      const href = a ? a.href : "";
      const m = /\\/vacancy\\/(\\d+)/.exec(href);
      const q = (sel) => { const el = it.querySelector(sel); return el ? el.textContent.trim() : ""; };
      return { externalId: m ? m[1] : "", url: href.split("?")[0], title: a ? a.textContent.trim() : "", company: q(${JSON.stringify(SEL.search.company)}), salaryRaw: q(${JSON.stringify(SEL.search.salary)}) };
    }).filter((c) => c.externalId);
  })()`;

  const search = async (s: BrowserSession, p: SearchParams): Promise<Card[]> => {
    await open(s, searchUrl(p), true);
    const state = extractInitialState(await s.html());
    const parsed = parseSearch(state);
    let cards = parsed.cards;
    log("hh.search", { matchedPath: parsed.matchedPath, count: cards.length, page: p.page ?? 0 });
    if (cards.length === 0) {
      const dom = await s.evaluate<Card[]>(DOM_SEARCH_JS).catch(() => [] as Card[]);
      if (Array.isArray(dom) && dom.length) {
        cards = dom.map((c) => ({ ...c, url: c.url || vacancyUrl(c.externalId) }));
        log("hh.search", { matchedPath: "dom", count: cards.length });
      }
    }
    const seen = new Set<string>();
    cards = cards.filter((c) => (seen.has(c.externalId) ? false : (seen.add(c.externalId), true)));
    return cards;
  };

  // ------------------------------------------------------------ vacancy

  const DOM_VACANCY_JS = `(() => {
    const q = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : ""; };
    return { title: q(${JSON.stringify(SEL.vacancy.title)}), company: q(${JSON.stringify(SEL.vacancy.company)}), salaryRaw: q(${JSON.stringify(SEL.vacancy.salary)}), description: q(${JSON.stringify(SEL.vacancy.description)}), area: q(${JSON.stringify(SEL.vacancy.area)}) };
  })()`;

  const fetchVacancy: HHClient["fetchVacancy"] = async (s, c) => {
    const url = c.url || vacancyUrl(c.externalId);
    await open(s, url, true);
    const state = extractInitialState(await s.html());
    const parsed = parseVacancy(state);
    log("hh.vacancy", { id: c.externalId, matchedPath: parsed.matchedPath });
    let v = parsed.vacancy;
    if (!v || !v.title) {
      const dom = await s.evaluate<{ title: string; company: string; salaryRaw: string; description: string; area: string }>(DOM_VACANCY_JS).catch(() => null);
      v = {
        externalId: c.externalId,
        url,
        title: dom?.title || c.title,
        company: dom?.company || c.company,
        salary: parseSalary(dom?.salaryRaw || c.salaryRaw),
        descriptionText: dom?.description ?? "",
        hasTest: false,
        requiresLetter: false,
        area: dom?.area ?? "",
        workFormat: "",
        publishedAt: null,
        archived: false,
        alreadyApplied: false,
      };
    }
    const text = await s.text(8000);
    const alreadyApplied = v.alreadyApplied || (await s.exists(SEL.vacancy.alreadyApplied)) || TEXT.alreadyApplied.some((t) => text.includes(t));
    const archived = v.archived || (await s.exists(SEL.vacancy.archivedMarker)) || TEXT.archived.some((t) => text.includes(t));
    const hasTest = v.hasTest || (await s.exists(SEL.vacancy.testMarker));
    const salary = v.salary.from || v.salary.to ? v.salary : parseSalary(c.salaryRaw);
    const title = v.title || c.title;
    const company = v.company || c.company;
    const vacancy: Omit<Vacancy, "id" | "firstSeenAt" | "lastSeenAt"> = {
      source: "hh",
      externalId: v.externalId || c.externalId,
      url: v.url || url,
      title,
      company,
      salaryFrom: salary.from,
      salaryTo: salary.to,
      currency: salary.currency,
      descriptionText: v.descriptionText,
      hasTest,
      requiresLetter: v.requiresLetter,
      area: v.area,
      workFormat: v.workFormat,
      publishedAt: v.publishedAt,
      archived,
      dedupHash: normalizeDedup(company, title),
    };
    return { vacancy, alreadyApplied };
  };

  // ------------------------------------------------------------ apply

  const isSuccessShown = async (s: BrowserSession): Promise<boolean> =>
    (await firstExisting(s, SEL.apply.success)) !== null || (await textHas(s, TEXT.applySuccess)) !== null;

  const isOtherCountryShown = async (s: BrowserSession): Promise<boolean> =>
    (await firstExisting(s, SEL.apply.otherCountryPopup)) !== null || (await textHas(s, TEXT.otherCountry)) !== null;

  // hh questionnaire blocks: [data-qa="task-body"] > [data-qa="task-question"] + inputs named task_<id>[_text].
  // Tags each block (data-sgz-q) and option label (data-sgz-opt) so fillAnswer can use plain selectors.
  const DOM_QUESTIONS_JS = `(() => Array.from(document.querySelectorAll('[data-qa="task-body"]')).map((b, idx) => {
    b.setAttribute("data-sgz-q", String(idx));
    const q = b.querySelector('[data-qa="task-question"]');
    const text = ((q && q.innerText) || "").trim();
    const choice = Array.from(b.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    const options = choice.map((i, j) => { const l = i.closest("label") || i.parentElement; l.setAttribute("data-sgz-opt", String(j)); return (l.innerText || "").trim(); });
    const kind = choice.length ? choice[0].type : b.querySelector("select") ? "select" : "text";
    return { idx, text, kind, options, required: true };
  }).filter((q) => q.text))()`;

  const detectQuestions = async (s: BrowserSession): Promise<Question[]> => {
    await s.waitForSelector(SEL.apply.submit[0]!, 5_000).catch(() => false);
    await s.waitForSelector('[data-qa="task-body"]', 1_500).catch(() => false);
    const dom = await s.evaluate<Question[]>(DOM_QUESTIONS_JS).catch(() => []);
    if (Array.isArray(dom) && dom.length) return dom.map((q) => (q.options?.length ? q : { idx: q.idx, text: q.text, kind: q.kind, required: q.required }));
    const hasForm = (await firstExisting(s, SEL.apply.questionnaire)) !== null || (await textHas(s, ["Вопросы от работодателя", "Ответьте на вопросы", "ответьте на вопрос"])) !== null;
    if (!hasForm) return [];
    const res = await s.extract(
      "На странице/в форме отклика есть вопросы от работодателя. Извлеки все вопросы по порядку: текст вопроса, тип (radio - один вариант, checkbox - несколько, text - свободный текст, select - выпадающий список, number, file), варианты ответа если есть, обязателен ли вопрос.",
      QuestionSchema,
    );
    return res.questions.map(toQuestion);
  };

  const fillLetter = async (s: BrowserSession, letter: string, id: string): Promise<{ ok: boolean; via: string }> => {
    let textarea = await firstExisting(s, SEL.apply.letterTextarea);
    if (!textarea) {
      const toggle = await firstExisting(s, SEL.apply.letterToggle);
      if (toggle) await s.click(toggle);
      else if (await textHas(s, [TEXT.letterToggle])) {
        await s.act("Нажми на «Сопроводительное письмо», чтобы раскрыть поле для текста письма", { cacheKey: "hh.apply.letter_toggle" });
      }
      await sleep(settleMs);
      textarea = await firstExisting(s, SEL.apply.letterTextarea);
    }
    if (textarea) {
      await s.fill(textarea, letter);
      return { ok: true, via: "fill" };
    }
    // The letter goes through `variables`, never inline: Stagehand keeps variables out of the LLM prompt.
    const r = await s.act("Вставь в поле сопроводительного письма текст %letter%", { cacheKey: "hh.apply.letter_fill", variables: { letter } });
    if (!r.success) log("hh.apply.letter_failed", { id, message: r.message });
    return { ok: r.success, via: "act" };
  };

  const fillAnswer = async (s: BrowserSession, q: Question, a: Answer, id: string): Promise<void> => {
    const key = (suffix: string) => `hh.apply.q.${id}.${q.idx}.${suffix}`;
    const choose = async (optionIdx: number): Promise<void> => {
      const option = q.options?.[optionIdx];
      if (option === undefined) throw new Error(`question ${q.idx}: option ${optionIdx} out of range`);
      const r = await s.act(`В вопросе «${q.text}» выбери вариант ответа %option%`, { cacheKey: key(`opt${optionIdx}`), variables: { option } });
      if (!r.success) throw new Error(`question ${q.idx}: could not choose option: ${r.message}`);
    };
    const block = `[data-sgz-q="${q.idx}"]`;
    if (q.kind !== "select" && (await s.exists(block))) {
      if (q.kind === "text" || q.kind === "number") {
        if (a.text || q.required) await s.fill(`${block} textarea, ${block} input[type="text"], ${block} input[type="number"]`, a.text ?? "");
        return;
      }
      if (q.kind === "radio" || q.kind === "checkbox") {
        for (const i of a.option_idxs ?? (a.option_idx !== undefined ? [a.option_idx] : [])) await s.click(`${block} [data-sgz-opt="${i}"]`);
        return;
      }
    }
    switch (q.kind) {
      case "radio":
      case "select":
        if (a.option_idx === undefined) throw new Error(`question ${q.idx}: option_idx missing`);
        await choose(a.option_idx);
        return;
      case "checkbox":
        for (const i of a.option_idxs ?? (a.option_idx !== undefined ? [a.option_idx] : [])) await choose(i);
        return;
      case "text":
      case "number": {
        const answer = a.text ?? "";
        if (!answer && !q.required) return;
        const r = await s.act(`В поле ответа на вопрос «${q.text}» введи %answer%`, { cacheKey: key("text"), variables: { answer } });
        if (!r.success) throw new Error(`question ${q.idx}: could not fill text: ${r.message}`);
        return;
      }
      case "file":
        if (q.required) throw new Error(`question ${q.idx}: file upload questions are not supported`);
        return;
    }
  };

  const openResponsePopup = async (s: BrowserSession): Promise<boolean> => {
    if (await s.exists(SEL.vacancy.respondTop)) {
      await s.click(SEL.vacancy.respondTop);
      return true;
    }
    const r = await s.act("Нажми кнопку «Откликнуться» на вакансии", { cacheKey: "hh.apply.open_popup" });
    return r.success;
  };

  const submitResponse = async (s: BrowserSession): Promise<boolean> => {
    const sel = await firstExisting(s, SEL.apply.submit);
    if (sel) {
      await s.click(sel);
      return true;
    }
    const r = await s.act("Нажми кнопку отправки отклика («Откликнуться» / «Отправить») в форме отклика", { cacheKey: "hh.apply.submit" });
    return r.success;
  };

  const confirmSent = async (s: BrowserSession): Promise<boolean> => {
    if (await isSuccessShown(s)) return true;
    const per = Math.max(1000, Math.floor(confirmTimeoutMs / TEXT.applySuccess.length));
    for (const t of TEXT.applySuccess) if (await s.waitForText(t, per)) return true;
    return isSuccessShown(s);
  };

  const apply = async (s: BrowserSession, req: ApplyRequest): Promise<ApplyResult> => {
    const v = req.vacancy;
    const id = v.externalId || vacancyIdFrom(v.url) || "unknown";
    const fail = async (step: string, reasonDetail: string, status: ApplyResult["status"] = Status.FAILED_UI, extra: Partial<ApplyResult> = {}): Promise<ApplyResult> => {
      const snapshotPath = await s.snapshot(`${id}-${step}`).catch(() => undefined);
      log("hh.apply.fail", { id, step, reasonDetail, snapshotPath });
      return { status, reasonDetail, ...(snapshotPath ? { snapshotPath } : {}), ...extra };
    };
    if (v.hasTest) return { status: Status.SKIP_TEST_REQUIRED, reasonDetail: "vacancy requires a test" };
    if (v.archived) return { status: Status.SKIP_ARCHIVED, reasonDetail: "vacancy is archived" };
    if (!req.coverLetter.trim() && v.requiresLetter) return { status: Status.FAILED_UI, reasonDetail: "cover letter required but empty" };

    try {
      await ensureAt(s, v.url || vacancyUrl(id));
      if ((await s.exists(SEL.vacancy.alreadyApplied)) || (await textHas(s, TEXT.alreadyApplied))) return { status: Status.SKIP_ALREADY_APPLIED, reasonDetail: "hh shows the response already exists" };
      if (await s.exists(SEL.vacancy.testMarker)) return { status: Status.SKIP_TEST_REQUIRED, reasonDetail: "response button leads to a test" };
      if ((await s.exists(SEL.vacancy.archivedMarker)) || (await textHas(s, TEXT.archived))) return { status: Status.SKIP_ARCHIVED, reasonDetail: "vacancy page says archived" };

      if (!(await openResponsePopup(s))) return fail("open-popup", "could not click «Откликнуться»");
      await sleep(settleMs);
      // Some vacancies navigate to a full-page form (/applicant/vacancy_response) instead of a popup; wait
      // until the form (or an instant-success marker) is there, tolerating the navigation in between.
      for (let i = 0; i < 20; i++) {
        const ready = await firstExisting(s, [...SEL.apply.submit, ...SEL.apply.success]).catch(() => null);
        if (ready) break;
        await sleep(500);
      }
      await assertNotBlocked(s);

      if (await isOtherCountryShown(s)) {
        if (!req.allowOtherCountry) {
          await s.pressEscape();
          return { status: Status.SKIP_FOREIGN, reasonDetail: "other-country warning and allow_other_country=false" };
        }
        if (await s.exists(SEL.apply.otherCountryConfirm)) await s.click(SEL.apply.otherCountryConfirm);
        else {
          const r = await s.act("Нажми «Всё равно откликнуться»", { cacheKey: "hh.apply.other_country_confirm" });
          if (!r.success) return fail("other-country", "could not confirm other-country popup");
        }
        await sleep(settleMs);
      }

      // hh sends instantly when the account has one resume and no letter is required.
      if (await isSuccessShown(s)) {
        if (req.dryRun) return { status: Status.SKIP_DRY_RUN, reasonDetail: "WARNING: hh sent the response instantly on popup open (dry run could not prevent it)" };
        if (req.coverLetter.trim()) {
          const r = await fillLetter(s, req.coverLetter, id);
          if (r.ok) await submitResponse(s);
        }
        return { status: Status.SENT, reasonDetail: "instant response (no popup)" };
      }

      if (await firstExisting(s, SEL.apply.resumeChooser)) {
        const r = await s.act("В форме отклика выбери резюме с названием %resumeTitle%", { cacheKey: "hh.apply.choose_resume", variables: { resumeTitle: req.resumeTitle } });
        if (!r.success) return fail("choose-resume", `could not choose resume «${req.resumeTitle}»: ${r.message}`);
      }

      const questions = await detectQuestions(s);
      if (req.dryRun) {
        await s.pressEscape();
        return { status: Status.SKIP_DRY_RUN, reasonDetail: `dry run: ${questions.length} question(s), nothing submitted`, questions };
      }

      if (req.coverLetter.trim()) {
        const r = await fillLetter(s, req.coverLetter, id);
        if (!r.ok && v.requiresLetter) return fail("letter", "letter is required but could not be filled", Status.FAILED_UI, { questions });
      }

      let answers: Answer[] = [];
      if (questions.length) {
        answers = await req.answerQuestions(questions);
        for (const q of questions) {
          const a = answers.find((x) => x.idx === q.idx);
          if (!a) {
            if (q.required) return fail("answers", `no answer for required question ${q.idx}`, Status.FAILED_UI, { questions, answers });
            continue;
          }
          try {
            await fillAnswer(s, q, a, id);
          } catch (e) {
            return fail(`q${q.idx}`, e instanceof Error ? e.message : String(e), Status.FAILED_UI, { questions, answers });
          }
        }
      }

      if (!(await submitResponse(s))) return fail("submit", "could not click submit", Status.FAILED_UI, { questions, answers });
      await sleep(settleMs);
      await assertNotBlocked(s);
      if (!(await confirmSent(s))) return fail("confirm", "no «Резюме доставлено» / «Отклик отправлен» after submit", Status.FAILED_NO_CONFIRMATION, { questions, answers });
      return { status: Status.SENT, reasonDetail: questions.length ? `sent with ${questions.length} answered question(s)` : "sent", questions, answers };
    } catch (e) {
      if (e instanceof RunAbortError) throw e;
      return fail("error", e instanceof Error ? e.message : String(e));
    }
  };

  // ------------------------------------------------------------ resumes

  const DOM_RESUMES_JS = `(() => Array.from(document.querySelectorAll(${JSON.stringify(SEL.resumes.titleLink)})).map((a) => {
    const m = /\\/resume\\/([0-9a-f]{20,40})/i.exec(a.href || "");
    return { hhResumeId: m ? m[1] : "", title: (a.textContent || "").trim(), url: (a.href || "").split("?")[0] };
  }).filter((r) => r.hhResumeId))()`;

  const readResumes = async (s: BrowserSession): Promise<{ hhResumeId: string; title: string; url: string }[]> => {
    const html = await s.html();
    let parsed = parseResumes(extractInitialState(html));
    if (!parsed.resumes.length) parsed = parseResumes(extractInitialState(html, "ResumeProfileFront-InitialState"));
    log("hh.resumes", { matchedPath: parsed.matchedPath, count: parsed.resumes.length });
    if (parsed.resumes.length) return parsed.resumes;
    const dom = await s.evaluate<{ hhResumeId: string; title: string; url: string }[]>(DOM_RESUMES_JS).catch(() => []);
    return Array.isArray(dom) ? dom : [];
  };

  const syncResumes: HHClient["syncResumes"] = async (s) => {
    await open(s, resumesUrl());
    const now = new Date().toISOString();
    return (await readResumes(s)).map((r) => ({ hhResumeId: r.hhResumeId, title: r.title, url: r.url, syncedAt: now }) satisfies Omit<HHResume, "id" | "userId" | "summary" | "direction" | "isGenerated">);
  };

  const resumeText: HHClient["resumeText"] = async (s, url) => {
    await open(s, url);
    return s.text(30_000);
  };

  const resumeCapacity: HHClient["resumeCapacity"] = async (s) => {
    await open(s, resumesUrl());
    const created = (await readResumes(s)).length;
    const m = TEXT.capacity.exec(await s.text(20_000));
    const left = m?.[1] ? Number(m[1]) : null;
    if (left !== null) return { created, max: created + left };
    if (await textHas(s, ["Достигнут лимит", "лимит резюме", "нельзя создать больше"])) return { created, max: created };
    return { created, max: 20 };
  };

  // Selector first (hh resume editor, 2026-09), LLM act() only when the selector is gone.
  const resumeStep = async (s: BrowserSession, id: string, name: string, sel: string, instruction: string, variables?: Record<string, string>): Promise<void> => {
    if (await s.waitForSelector(sel, 8_000)) await s.click(sel); // editors re-render the page after each save
    else {
      const r = await s.act(instruction, { cacheKey: `hh.resume.${name}`, ...(variables ? { variables } : {}) });
      if (!r.success) {
        const snap = await s.snapshot(`resume-${id}-${name}`).catch(() => "");
        throw new Error(`resume step «${name}» failed: ${r.message} (snapshot ${snap})`);
      }
    }
    await sleep(settleMs);
  };

  const editResume: HHClient["editResume"] = async (s, resumeId, edit) => {
    const step = (name: string, sel: string, instruction: string, variables?: Record<string, string>) => resumeStep(s, resumeId, name, sel, instruction, variables);
    const fill = async (name: string, sel: string, value: string, instruction: string): Promise<void> => {
      if (await s.waitForSelector(sel, 5_000)) await s.fill(sel, value);
      else await step(name, sel, instruction, { value });
    };
    const R = SEL.resumes;
    await open(s, resumeUrl(resumeId));
    await step("edit_title_open", R.editTitle, "Нажми на кнопку редактирования желаемой должности резюме");
    await fill("edit_title_fill", R.titleInput, edit.title, "Очисти поле желаемой должности и введи %value%");
    await step("edit_title_save", R.save, "Нажми «Сохранить» в форме редактирования");
    await step("edit_about_open", R.editAbout, "Нажми на кнопку редактирования раздела «О себе»");
    await fill("edit_about_fill", R.aboutInput, edit.about, "Очисти поле «О себе» и введи %value%");
    await step("edit_about_save", R.save, "Нажми «Сохранить» в форме редактирования");
    await step("edit_skills_open", R.editSkills, "Нажми на кнопку редактирования раздела «Ключевые навыки»");
    if (await s.waitForSelector(R.skillInput, 5_000)) {
      for (let i = 0; i < 40 && (await s.exists(R.skillChipDelete)); i++) await s.click(R.skillChipDelete);
      for (const skill of edit.keySkills) {
        await s.fill(R.skillInput, skill);
        await s.pressKey("Enter");
        await sleep(200);
      }
    } else await step("edit_skills_fill", R.skillInput, "Замени список ключевых навыков на следующие, каждый как отдельный навык: %skills%", { skills: edit.keySkills.join(", ") });
    await step("edit_skills_save", R.save, "Нажми «Сохранить» в форме редактирования");
  };

  const duplicateResume: HHClient["duplicateResume"] = async (s, baseResumeId, edit) => {
    const step = (name: string, sel: string, instruction: string, variables?: Record<string, string>) => resumeStep(s, baseResumeId, name, sel, instruction, variables);
    const R = SEL.resumes;
    await open(s, resumesUrl());
    const before = new Set((await readResumes(s)).map((r) => r.hhResumeId));
    if (!before.has(baseResumeId)) throw new Error(`duplicateResume: base resume ${baseResumeId} not found in the list`);
    await step("open_menu", `[data-qa="resume"]:has([data-qa="resume-card-link-${baseResumeId}"]) ${R.cardMenu}`, "Открой меню действий (три точки / «Ещё») у резюме, ссылка которого содержит %hash%", { hash: baseResumeId });
    await step("duplicate", R.duplicate[0]!, "Нажми «Дублировать» в открытом меню резюме");
    await sleep(settleMs * 3);
    await open(s, resumesUrl());
    const after = (await readResumes(s)).map((r) => r.hhResumeId).filter((h) => !before.has(h));
    if (after.length !== 1) {
      await s.snapshot(`resume-${baseResumeId}-copy-not-found`).catch(() => "");
      throw new Error(`duplicateResume: expected exactly one new resume, found ${after.length}`);
    }
    const newId = after[0]!;
    try {
      await editResume(s, newId, edit);
    } catch (e) {
      throw new Error(`duplicateResume: copy ${newId} created but editing failed, fix it manually: ${e instanceof Error ? e.message : String(e)}`);
    }
    return newId;
  };
  const publishResume: HHClient["publishResume"] = async (s, resumeId) => {
    const R = SEL.resumes;
    await open(s, `${HH_ORIGIN}/profile/resume?resume=${resumeId}`);
    if (await s.waitForSelector(R.wizardSelectJob, 5_000)) {
      await s.click(R.wizardSelectJob);
      await sleep(settleMs * 3);
    }
    // Every step is pre-filled from the original resume: «Сохранить и продолжить» until hh lands on published=true.
    for (let step = 0; step < 12; step++) {
      if (/published=true/.test(await s.url())) return true;
      if (!(await s.waitForSelector(R.wizardNext, 5_000))) break;
      await s.click(R.wizardNext);
      await sleep(settleMs * 5);
    }
    if (/published=true/.test(await s.url())) return true;
    await s.snapshot(`resume-${resumeId}-publish`).catch(() => "");
    return false;
  };

  const touchResume: HHClient["touchResume"] = async (s, url) => {
    await open(s, url);
    const sel = await firstExisting(s, SEL.resumes.touchButton);
    if (sel) {
      const disabled = await s.evaluate<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); return !!(b && (b.disabled || b.getAttribute("aria-disabled") === "true")); })()`).catch(() => false);
      if (disabled) return;
      await s.click(sel);
      return;
    }
    if (await textHas(s, [TEXT.touch])) await s.act("Нажми кнопку «Поднять в поиске», если она активна", { cacheKey: "hh.resume.touch" });
  };

  // ------------------------------------------------------------ chats

  const DOM_THREADS_JS = `(() => Array.from(document.querySelectorAll(${JSON.stringify(SEL.negotiations.item)})).map((it) => {
    const a = it.querySelector(${JSON.stringify(SEL.negotiations.chatLink)});
    const t = it.textContent || "";
    const idm = /(?:id|topic|negotiation)[=\\/](\\d+)/.exec(it.getAttribute("data-id") || (a && a.href) || "");
    const vm = /\\/vacancy\\/(\\d+)/.exec(it.innerHTML);
    return { negotiationId: it.getAttribute("data-id") || (idm ? idm[1] : ""), chatUrl: a ? a.href : "", unread: !!it.querySelector(${JSON.stringify(SEL.negotiations.unread)}), employer: "", state: /Приглашение/.test(t) ? "Приглашение" : /Отказ/.test(t) ? "Отказ" : /Не просмотрено/.test(t) ? "Не просмотрено" : /Просмотрено/.test(t) ? "Просмотрено" : "", vacancyExternalId: vm ? vm[1] : null };
  }).filter((x) => x.negotiationId))()`;

  const listThreads: HHClient["listThreads"] = async (s, onlyUnread, since) => {
    type Row = Pick<ParsedThread, "negotiationId" | "chatUrl" | "unread" | "employer" | "state" | "vacancyExternalId" | "lastModified">;
    const readPage = async (page: number): Promise<{ rows: Row[]; pageCount: number }> => {
      await open(s, negotiationsUrl({ onlyUnread: onlyUnread && !since, page }), true);
      const state = extractInitialState(await s.html());
      const parsed = parseNegotiations(state);
      log("hh.negotiations", { page, matchedPath: parsed.matchedPath, count: parsed.threads.length });
      let rows: Row[] = parsed.threads;
      if (!rows.length) {
        const dom = await s.evaluate<Row[]>(DOM_THREADS_JS).catch(() => []);
        if (Array.isArray(dom)) rows = dom;
      }
      const pc = Number(get(state, "applicantNegotiations.pageCount"));
      return { rows, pageCount: Number.isFinite(pc) && pc > 0 ? pc : 1 };
    };
    let { rows: threads, pageCount } = await readPage(0);
    // hh's order isn't strictly by last change, so with `since` read every page (capped) and let the caller filter.
    for (let page = 1; since && page < Math.min(pageCount, 10); page++) {
      await sleep(settleMs);
      threads = threads.concat((await readPage(page)).rows);
    }
    if (onlyUnread) threads = threads.filter((t) => t.unread);
    return threads.map((t) => ({ negotiationId: t.negotiationId, chatUrl: t.chatUrl, unread: t.unread, employer: t.employer, state: t.state, vacancyExternalId: t.vacancyExternalId, ...(t.lastModified ? { lastModified: t.lastModified } : {}) }));
  };

  const negotiationIdFromUrl = (url: string): string => /(?:id|chat|negotiations\/item)[=/](\d+)/.exec(url)?.[1] ?? url;

  const readThread: HHClient["readThread"] = async (s, chatUrl) => {
    await open(s, chatUrl, true);
    const html = await s.html();
    const parsed = parseChatik(extractInitialState(html, "Chatik-InitialState")) ?? parseChat(extractInitialState(html));
    log("hh.chat", { matchedPath: parsed.matchedPath, count: parsed.messages.length });
    let messages = parsed.messages;
    let survey = parsed.survey;
    let employer = parsed.employer;
    let vacancyExternalId = parsed.vacancyExternalId;
    if (!messages.length) {
      const ex = await s.extract(
        "Это чат с работодателем на hh.ru. Извлеки все сообщения по порядку (author: employer - работодатель, bot - чат-бот/автоответ, me - соискатель), название работодателя, id вакансии если виден, и если есть виджет опроса с вопросами - список вопросов с вариантами.",
        ChatExtractSchema,
      );
      messages = ex.messages.map((m) => ({ hhMessageId: null, direction: m.author === "me" ? "out" : "in", author: m.author, text: m.text, isQuestion: m.author !== "me" && asksQuestion(m.text) }));
      survey = ex.survey.map(toQuestion);
      employer = employer || ex.employer || "";
      vacancyExternalId = vacancyExternalId ?? (ex.vacancyId && /^\d+$/.test(ex.vacancyId) ? ex.vacancyId : null);
    }
    const isBot = messages.some((m) => m.author === "bot") || survey.length > 0;
    const detail: ThreadDetail = {
      thread: { hhNegotiationId: negotiationIdFromUrl(chatUrl), isBot, vacancyId: null, employer, state: parsed.rejected ? "rejected" : "new", lastSeenAt: new Date().toISOString() },
      vacancyExternalId,
      messages: messages.map((m) => ({ hhMessageId: m.hhMessageId, direction: m.direction, author: m.author, text: m.text, isQuestion: m.isQuestion, answered: false, ...(m.createdAt ? { createdAt: m.createdAt } : {}) })),
      survey,
      ...(parsed.writable !== undefined ? { writable: parsed.writable } : {}),
      ...(parsed.choices?.length ? { choices: parsed.choices } : {}),
    };
    return detail;
  };

  const sendMessage: HHClient["sendMessage"] = async (s, chatUrl, text) => {
    await ensureAt(s, chatUrl);
    // A chat-bot question with quick-reply buttons only accepts a button press, not typed text.
    const pressed = await s
      .evaluate<boolean>(`(() => { const want = ${JSON.stringify(text.trim())}; const b = Array.from(document.querySelectorAll('[data-qa^="participant-action-message-"]')).find((x) => (x.textContent || "").trim() === want); if (!b) return false; b.click(); return true; })()`)
      .catch(() => false);
    if (pressed) {
      if (!(await s.waitForText(text.trim().slice(0, 60), confirmTimeoutMs))) throw new Error("sendMessage: quick-reply pressed but the answer did not appear");
      return;
    }
    const input = await firstExisting(s, SEL.chat.input);
    if (input) await s.fill(input, text);
    else {
      const r = await s.act("Введи в поле нового сообщения чата текст %text%", { cacheKey: "hh.chat.fill", variables: { text } });
      if (!r.success) {
        await s.snapshot(`chat-${negotiationIdFromUrl(chatUrl)}-fill`).catch(() => "");
        throw new Error(`sendMessage: could not fill the message: ${r.message}`);
      }
    }
    const send = await firstExisting(s, SEL.chat.send);
    if (send) await s.click(send);
    else {
      const r = await s.act("Нажми кнопку отправки сообщения в чате", { cacheKey: "hh.chat.send" });
      if (!r.success) {
        await s.snapshot(`chat-${negotiationIdFromUrl(chatUrl)}-send`).catch(() => "");
        throw new Error(`sendMessage: could not click send: ${r.message}`);
      }
    }
    const probe = text.trim().slice(0, 60);
    if (!(await s.waitForText(probe, confirmTimeoutMs))) {
      await s.snapshot(`chat-${negotiationIdFromUrl(chatUrl)}-confirm`).catch(() => "");
      throw new Error("sendMessage: the sent message did not appear in the thread");
    }
  };

  const submitSurvey: HHClient["submitSurvey"] = async (s, chatUrl, answers) => {
    const detail = await readThread(s, chatUrl);
    if (!detail.survey.length) throw new Error("submitSurvey: no survey widget found");
    const nid = negotiationIdFromUrl(chatUrl);
    for (const q of detail.survey) {
      const a = answers.find((x) => x.idx === q.idx);
      if (!a) {
        if (q.required) throw new Error(`submitSurvey: no answer for required question ${q.idx}`);
        continue;
      }
      try {
        await fillAnswer(s, q, a, `chat${nid}`);
      } catch (e) {
        await s.snapshot(`chat-${nid}-survey-q${q.idx}`).catch(() => "");
        throw e;
      }
    }
    const r = await s.act("Нажми кнопку отправки ответов опроса в чате («Отправить» / «Ответить»)", { cacheKey: "hh.chat.survey_submit" });
    if (!r.success) {
      await s.snapshot(`chat-${nid}-survey-submit`).catch(() => "");
      throw new Error(`submitSurvey: could not submit: ${r.message}`);
    }
  };

  return { checkLogin, assertNotBlocked, search, fetchVacancy, apply, syncResumes, resumeText, resumeCapacity, duplicateResume, editResume, publishResume, touchResume, listThreads, readThread, sendMessage, submitSurvey };
};
