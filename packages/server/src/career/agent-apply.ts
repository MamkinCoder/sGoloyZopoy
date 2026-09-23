// Universal apply flow for custom career sites: natural-language act/extract over BrowserSession,
// guided by SiteProfile.apply_hints. Cache keys are stable so Stagehand replays selectors per host.
import { Status } from "@sgz/shared";
import type { Answer, BrowserSession, CareerApplyRequest, CareerApplyResult, Question } from "@sgz/shared";
import { answerValues, byIdx, splitName } from "./ats/apply-common.js";
import { copyFileSync } from "node:fs";
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
    await s.goto(req.vacancy.url);
    const opened = await s.act(
      `Open the application form for this vacancy: click the button labelled like "Apply", "Apply now", "Откликнуться", "Отправить резюме", "Хочу в команду".${hints}`,
      { cacheKey: "career.apply.open" },
    );
    learned.push(opened.success ? "apply button opens the form" : "no apply button found; form assumed inline");

    const tagged = await s.evaluate<{ first?: boolean; last?: boolean }>(TAG_NAME_FIELDS_JS).catch(() => ({}) as { first?: boolean; last?: boolean });
    let nameRes: { success: boolean };
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
    const coverRes = req.coverLetter
      ? await s.act("If there is a cover letter / message / comment / about-you text area, fill it with %cover_letter%", {
          cacheKey: "career.apply.cover",
          variables,
        })
      : { success: false };
    learned.push(
      `fields: name${nameRes.success ? "" : "(missing)"}, email${emailRes.success ? "" : "(missing)"}, phone${phoneRes.success ? "" : "(none)"}, cover letter${coverRes.success ? "" : "(none)"}`,
    );

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

    const submit = await s.act('Submit the application form: click the "Submit" / "Send" / "Отправить" / "Откликнуться" button', {
      cacheKey: "career.apply.submit",
    });
    if (!submit.success) return fail(Status.FAILED_UI, `submit failed: ${submit.message}`, { questions, answers });

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
    return fail(Status.FAILED_UI, `agent apply error: ${err instanceof Error ? err.message : String(err)}`);
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
