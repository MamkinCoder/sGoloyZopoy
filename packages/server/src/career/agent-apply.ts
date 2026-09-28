// Universal apply flow for custom career sites: natural-language act/extract over BrowserSession,
// guided by SiteProfile.apply_hints. Cache keys are stable so Stagehand replays selectors per host.
import { errMessage } from "@sgz/shared";
import { Status } from "@sgz/shared";
import type { Answer, BrowserSession, CareerApplyRequest, CareerApplyResult, Question } from "@sgz/shared";
import { answerValues, byIdx, splitName } from "./ats/apply-common.js";
import { copyFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { truncate } from "./http.js";
import { confirmSchema, questionsSchema } from "./schemas.js";

const SUCCESS_PHRASES = ["Спасибо", "Thank you", "received", "отправлен", "успешно", "Thanks for applying"];

const WAIT_PER_PHRASE_MS = 2500;

// Tags name inputs by what they are for (label / placeholder / aria / name), so «Фамилия» gets the last
// name and «Имя» the first name deterministically; the LLM step alone mixed them up on rabota.sber.ru.
const TAG_NAME_FIELDS_JS = `(() => {
  const labelOf = (el) => {
    const byFor = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
    const near = el.parentElement && el.parentElement.textContent.length < 40 ? el.parentElement.textContent : "";
    return [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.name, byFor && byFor.textContent, el.closest("label") && el.closest("label").textContent, near].filter(Boolean).join(" ").toLowerCase();
  };
  const out = {};
  for (const el of document.querySelectorAll('input[type="text"], input:not([type])')) {
    const t = labelOf(el);
    if (/фамили|surname|last.?name/.test(t)) { el.setAttribute("data-sgz-field", "last"); out.last = true; }
    else if (/отчеств|patronymic|middle.?name/.test(t)) continue;
    else if (/(^|[^а-яё])имя([^а-яё]|$)|first.?name|given.?name/.test(t)) { el.setAttribute("data-sgz-field", "first"); out.first = true; }
  }
  return out;
})()`;

// Ticks unchecked consent / personal-data / privacy checkboxes (submit stays disabled without them).
const TICK_CONSENT_JS = `(() => {
  let n = 0;
  for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
    const box = cb.closest("label") || cb.parentElement;
    const t = ((box && box.textContent) || "") + " " + ((box && box.parentElement && box.parentElement.textContent) || "");
    if (!cb.checked && /соглас|персональн|политик|обработк|consent|privacy|agree/i.test(t)) { (cb.closest("label") || cb).click(); n++; }
  }
  return n;
})()`;

// The character limit of the cover-letter field: maxlength, or a counter / hint near it («0 / 500», «до 1000
// символов»). The field is the textarea labelled like a letter / message / comment, else the only textarea.
export const LETTER_LIMIT_JS = `(() => {
  const areas = [...document.querySelectorAll("textarea")].filter((t) => t.offsetParent !== null);
  const ctx = (t) => { let n = t, s = ""; for (let i = 0; i < 3 && n; i++, n = n.parentElement) s = n.textContent || ""; return (s + " " + (t.placeholder || "") + " " + (t.name || "") + " " + (t.getAttribute("aria-label") || "")).slice(0, 600); };
  const t = areas.find((a) => /сопровод|письм|cover|letter|сообщени|message|комментар|comment|о себе|about/i.test(ctx(a))) || (areas.length === 1 ? areas[0] : null);
  if (!t) return 0;
  if (t.maxLength > 0) return t.maxLength;
  const m = ctx(t).match(/\\d+\\s*\\/\\s*(\\d{2,5})|(?:до|не более|максимум|max(?:imum)?)\\s*(\\d{2,5})\\s*(?:символ|знак|char)/i);
  return m ? Number(m[1] || m[2]) : 0;
})()`;

// Records what a submit click set off: a form submit event, a non-GET fetch / XHR, or leaving the page. A click
// can "succeed" and still do nothing (corp.ivi.ru: the button was clicked, the form never left data-status=init),
// so the flow checks this probe instead of trusting the click. Re-arming resets the log.
export const SUBMIT_PROBE_JS = `(() => {
  if (window.__sgzSubmit) { window.__sgzSubmit.what = []; return true; }
  const p = (window.__sgzSubmit = { what: [] });
  const hit = (w) => p.what.push(w);
  document.addEventListener("submit", () => hit("submit"), true);
  window.addEventListener("beforeunload", () => hit("unload"));
  const f = window.fetch;
  if (f) window.fetch = function (input, init) {
    const m = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    if (m !== "GET") hit("fetch " + m);
    return f.apply(this, arguments);
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m) { this.__sgzMethod = String(m).toUpperCase(); return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () { if (this.__sgzMethod && this.__sgzMethod !== "GET") hit("xhr " + this.__sgzMethod); return send.apply(this, arguments); };
  return true;
})()`;

/** Probe log; null once the page is gone (navigated away = the submit went somewhere). */
const PROBE_READ_JS = `(window.__sgzSubmit ? window.__sgzSubmit.what : null)`;

// Submits the form of the button the click hit, the way the browser would: requestSubmit fires the submit event
// the site's handlers listen for. No form around the button: a DOM click, which skips hit-testing.
export const requestSubmitJs = (selector: string): string => `(() => {
  let sel = ${JSON.stringify(selector)};
  if (sel.startsWith("xpath=")) sel = sel.slice(6);
  const b = sel.startsWith("/") || sel.startsWith("(") ? document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue : document.querySelector(sel);
  if (!b) return "button gone";
  const form = b.form || b.closest("form");
  if (!form) { b.click(); return "click()"; }
  try { form.requestSubmit(b); } catch { form.requestSubmit(); }
  return "requestSubmit()";
})()`;

/** How long a submit gets to show an effect, and the human-like dwell before it; tests shorten them. */
export const submitTiming = {
  effectMs: 6000,
  pollMs: 500,
  dwellMs: [20_000, 40_000] as [number, number],
  /** Warm-up before the vacancy page: google.com (its cookies feed reCAPTCHA), then the site's home page. */
  googleMs: [3_000, 6_000] as [number, number],
  homeMs: [8_000, 15_000] as [number, number],
};
const between = ([lo, hi]: [number, number]): number => Math.round(lo + Math.random() * (hi - lo));

/** A person reaches a vacancy from somewhere: a short visit to google.com and the site's home page first. Best effort. */
async function warmUp(s: BrowserSession, vacancyUrl: string): Promise<void> {
  for (const [url, ms] of [
    ["https://www.google.com/", submitTiming.googleMs],
    [new URL(vacancyUrl).origin + "/", submitTiming.homeMs],
  ] as const) {
    try {
      await s.goto(url);
      await s.humanize([], between(ms));
    } catch {
      // unreachable or slow: skip this stop
    }
  }
}

// Marks the submit button of the form around `fieldSelector` (data-sgz-submit), so the dwell can end on it.
export const markSubmitJs = (fieldSelector: string): string => `(() => {
  let sel = ${JSON.stringify(fieldSelector)};
  if (sel.startsWith("xpath=")) sel = sel.slice(6);
  const f = sel.startsWith("/") || sel.startsWith("(") ? document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue : document.querySelector(sel);
  const form = f && (f.form || f.closest("form"));
  const b = form && form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  if (!b) return false;
  b.setAttribute("data-sgz-submit", "1");
  return true;
})()`;

/** What the submit set off within a few seconds ("left the page" when the probe is gone), or "" for nothing. */
async function submitEffect(s: BrowserSession): Promise<string> {
  const deadline = Date.now() + submitTiming.effectMs;
  for (;;) {
    const what = await s.evaluate<string[] | null>(PROBE_READ_JS).catch(() => undefined);
    if (what === null) return "left the page";
    if (what?.length) return [...new Set(what)].join(", ");
    if (Date.now() >= deadline) return "";
    await sleep(submitTiming.pollMs);
  }
}

/** «Петров_Иван_CV.pdf» instead of the internal «5.pdf» that recruiters would otherwise see. */
export const cvFileName = (fullName: string): string => {
  const { first, last } = splitName(fullName);
  return `${[last, first].filter(Boolean).join("_").replace(/[^\p{L}\d_-]+/gu, "") || "CV"}_CV.pdf`;
};

export async function applyViaAgent(s: BrowserSession, req: CareerApplyRequest): Promise<CareerApplyResult> {
  const snapName = `career-${req.site.slug}-${req.vacancy.externalId.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}`;
  const snapshot = async (): Promise<string | undefined> => {
    try {
      return await s.snapshot(snapName);
    } catch {
      return undefined;
    }
  };
  const fail = async (status: Status, reasonDetail: string, extra: Partial<CareerApplyResult> = {}): Promise<CareerApplyResult> => ({
    status,
    reasonDetail,
    snapshotPath: await snapshot(),
    ...extra,
  });

  const hints = req.site.profile.apply_hints ? ` Hints from previous runs: ${req.site.profile.apply_hints}` : "";
  const { first, last } = splitName(req.profile.full_name);
  const variables = {
    full_name: req.profile.full_name,
    first_name: first,
    last_name: last || first,
    email: req.profile.email,
    phone: req.profile.phone,
    cover_letter: req.coverLetter,
  };
  const learned: string[] = [];

  try {
    if (!req.dryRun) await warmUp(s, req.vacancy.url);
    await s.goto(req.vacancy.url);
    const opened = await s.act(
      `Open the application form for this vacancy: click the button labelled like "Apply", "Apply now", "Откликнуться", "Отправить резюме", "Хочу в команду".${hints}`,
      { cacheKey: "career.apply.open" },
    );
    learned.push(opened.success ? "apply button opens the form" : "no apply button found; form assumed inline");

    const tagged = await s.evaluate<{ first?: boolean; last?: boolean }>(TAG_NAME_FIELDS_JS).catch(() => ({}) as { first?: boolean; last?: boolean });
    let nameRes: { success: boolean; selector?: string };
    if (tagged.first && tagged.last) {
      await s.fill('[data-sgz-field="first"]', first);
      await s.fill('[data-sgz-field="last"]', last || first);
      nameRes = { success: true };
    } else {
      nameRes = await s.act(
        "Fill the applicant name field with %full_name%. If first and last name are separate fields, fill them with %first_name% and %last_name%.",
        { cacheKey: "career.apply.name", variables },
      );
    }
    const emailRes = await s.act("Fill the email field with %email%", { cacheKey: "career.apply.email", variables });
    if (!nameRes.success && !emailRes.success) {
      return fail(Status.FAILED_UI, "application form not found: neither name nor email field could be filled");
    }
    const phoneRes = req.profile.phone
      ? await s.act("Fill the phone number field with %phone%", { cacheKey: "career.apply.phone", variables })
      : { success: false };
    const limit = req.coverLetter ? await s.evaluate<number>(LETTER_LIMIT_JS).catch(() => 0) : 0;
    if (limit && req.coverLetter.length > limit) {
      variables.cover_letter = req.fitLetter ? await req.fitLetter(limit) : req.coverLetter;
      if (variables.cover_letter.length > limit) variables.cover_letter = variables.cover_letter.slice(0, limit).trimEnd();
      learned.push(`cover letter limit ${limit} chars`);
    }
    const coverRes = req.coverLetter
      ? await s.act("If there is a cover letter / message / comment / about-you text area, fill it with %cover_letter%", {
          cacheKey: "career.apply.cover",
          variables,
        })
      : { success: false };
    learned.push(
      `fields: name${nameRes.success ? "" : "(missing)"}, email${emailRes.success ? "" : "(missing)"}, phone${phoneRes.success ? "" : "(none)"}, cover letter${coverRes.success ? "" : "(none)"}`,
    );

    // Fields the flow filled, top to bottom: retyped by hand on a real send, then the mouse path before submit.
    const fields = [...(tagged.first && tagged.last ? ['[data-sgz-field="first"]', '[data-sgz-field="last"]'] : [nameRes.selector]), emailRes.selector, "selector" in phoneRes ? phoneRes.selector : undefined, "selector" in coverRes ? coverRes.selector : undefined].filter(
      (x): x is string => !!x,
    );
    if (!req.dryRun) {
      let retyped = 0;
      for (const f of fields) if (await s.retype(f)) retyped++;
      learned.push(`retyped ${retyped}/${fields.length} fields`);
    }

    const fileSelector = await findFileInput(s);
    if (!fileSelector) return fail(Status.FAILED_UI, "no file input for resume upload found");
    const named = join(dirname(req.resumePdfPath), cvFileName(req.profile.full_name));
    copyFileSync(req.resumePdfPath, named);
    await s.upload(fileSelector, named);
    learned.push(`resume input: ${fileSelector}`);

    const questions = await extractQuestions(s);
    let answers: Answer[] = [];
    if (questions.length) {
      answers = await req.answerQuestions(questions);
      const answered = byIdx(answers);
      for (const q of questions) {
        if (q.kind === "file") continue;
        const values = answerValues(q, answered.get(q.idx));
        if (!values.length) continue;
        const res = await s.act(
          `Answer the form question "${truncate(q.text, 200)}" with: %answer% (choose the matching option(s), check the boxes, or type into the field as appropriate)`,
          { variables: { answer: values.join("; ") } },
        );
        if (!res.success && q.required) learned.push(`required question not answered: ${truncate(q.text, 80)}`);
      }
      learned.push(`extra questions (${questions.length}): ${truncate(questions.map((q) => q.text).join(" | "), 240)}`);
    } else {
      learned.push("no extra questions");
    }

    const ticked = await s.evaluate<number>(TICK_CONSENT_JS).catch(() => 0);
    if (ticked) learned.push(`consent checkboxes ticked: ${ticked}`);
    else await s.act("If there is an unchecked consent / personal data processing / privacy checkbox, check it", { cacheKey: "career.apply.consent" }).catch(() => undefined);

    if (req.dryRun) {
      return {
        status: Status.SKIP_DRY_RUN,
        reasonDetail: "dry run: form filled, not submitted",
        snapshotPath: await snapshot(),
        questions,
        answers,
      };
    }

    // reCAPTCHA v3 and similar score behaviour: scroll, move the mouse through the filled fields to the submit
    // button, and spend a human amount of time on the page before submitting.
    const marked = fields.length ? await s.evaluate<boolean>(markSubmitJs(fields[fields.length - 1]!)).catch(() => false) : false;
    await s.humanize([...fields, ...(marked ? ['[data-sgz-submit="1"]'] : [])], between(submitTiming.dwellMs));

    const armed = await s.evaluate<boolean>(SUBMIT_PROBE_JS).catch(() => false);
    const submit = await s.act('Submit the application form: click the "Submit" / "Send" / "Отправить" / "Откликнуться" button', {
      cacheKey: "career.apply.submit",
    });
    if (!submit.success) return fail(Status.FAILED_UI, `submit failed: ${submit.message}`, { questions, answers });
    let effect = armed ? await submitEffect(s) : "not checked";
    if (!effect && submit.selector) {
      await s.evaluate(SUBMIT_PROBE_JS).catch(() => undefined);
      const how = await s.evaluate<string>(requestSubmitJs(submit.selector)).catch((e: unknown) => `error: ${errMessage(e)}`);
      // Not in this document (a form in an iframe, which the probe cannot see): fall back to the confirmation check.
      effect = how === "button gone" ? "not checked (button outside the main document)" : await submitEffect(s);
      learned.push(`submit click did nothing; ${how}: ${effect || "nothing either"}`);
    }
    if (!effect) return fail(Status.FAILED_UI, "submit had no effect: no form submit, request or navigation after the click", { questions, answers });
    learned.push(`submit set off: ${effect}`);

    const confirmed = await confirmSubmission(s);
    if (!confirmed) {
      return fail(Status.FAILED_NO_CONFIRMATION, "no success message after submit", { questions, answers });
    }
    learned.push(`submit ok; confirmation: "${confirmed}"`);
    return {
      status: Status.SENT,
      reasonDetail: `confirmed: ${confirmed}`,
      questions,
      answers,
      learnedHints: truncate(learned.join("; "), 600),
    };
  } catch (err) {
    return fail(Status.FAILED_UI, `agent apply error: ${errMessage(err)}`);
  }
}

async function findFileInput(s: BrowserSession): Promise<string | null> {
  const observed = await s.observe("file input for uploading a resume / CV (input type=file)").catch(() => []);
  const hit = observed.find((o) => o.selector);
  if (hit) return hit.selector;
  if (await s.exists('input[type="file"]').catch(() => false)) return 'input[type="file"]';
  return null;
}

async function extractQuestions(s: BrowserSession): Promise<Question[]> {
  const res = await s
    .extract(
      "List the remaining unanswered fields and questions of the application form, excluding name, email, phone, resume upload and cover letter. For each give the question text, its kind (radio | checkbox | text | select | number | file), the options if any, and whether it is required.",
      questionsSchema,
    )
    .catch(() => ({ questions: [] as Question[] }));
  return res.questions.map((q, idx) => ({ ...q, idx }));
}

async function confirmSubmission(s: BrowserSession): Promise<string | null> {
  for (const phrase of SUCCESS_PHRASES) {
    if (await s.waitForText(phrase, WAIT_PER_PHRASE_MS).catch(() => false)) return phrase;
  }
  const res = await s
    .extract("Was the application submitted successfully? Report submitted=true only if a confirmation/thank-you message is visible, and quote it as message.", confirmSchema)
    .catch(() => null);
  return res?.submitted ? res.message || "confirmation extracted" : null;
}
