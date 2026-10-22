// Google Forms over plain HTTP: employers on hh.ru often send a docs.google.com/forms link in the chat. The public
// viewform page embeds the whole form as JSON (FB_PUBLIC_LOAD_DATA_), and formResponse takes entry.<id> fields,
// so no browser is needed. Only what we can fill faithfully is supported; anything else (file upload, grid,
// date/time, answer-dependent branching, login-only forms) is reported as `unsupported` and goes to the human.
import type { Answer, Question } from "@sgz/shared";
import { decodeEntities, httpFetch } from "../career/http.js";

export interface GFormQuestion {
  /** The `entry.<id>` field name suffix. */
  entry: string;
  title: string;
  kind: Question["kind"];
  options: string[];
  required: boolean;
}

export interface GForm {
  id: string;
  action: string;
  viewUrl: string;
  title: string;
  description: string;
  questions: GFormQuestion[];
  /** Hidden inputs of the form (fbzx, partialResponse, fvv, dlut ...), sent back as they are. */
  hidden: Record<string, string>;
  pages: number;
  /** The form collects the respondent's email (field `emailAddress`). */
  needsEmail: boolean;
  /** Reasons the form cannot be filled automatically; empty = fillable. */
  unsupported: string[];
}

const URL_RE = /https?:\/\/(?:docs\.google\.com\/forms\/[^\s<>"'`]+|forms\.gle\/[A-Za-z0-9_-]+)/gi;

/** Google Form links in a chat message, deduplicated, trailing punctuation removed. */
export function extractFormUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) out.add(m[0].replace(/[)\].,;:!?»"']+$/u, ""));
  return [...out];
}

/** A stable key of the form behind a link (the id in /d/e/<id>/ or /d/<id>/, the code of forms.gle), else the link. */
export function formKey(url: string): string {
  const m = /\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]+)/.exec(url) ?? /forms\.gle\/([A-Za-z0-9_-]+)/.exec(url);
  return m ? m[1]! : url.split(/[?#]/)[0]!;
}

/** The fillable address of a link: .../viewform (edit and other tails are rewritten, short links are left to redirect). */
export function viewUrl(url: string): string {
  const m = /^(https?:\/\/docs\.google\.com\/forms\/d\/(?:e\/)?[A-Za-z0-9_-]+)/i.exec(url);
  return m ? `${m[1]}/viewform` : url;
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return m ? decodeEntities(m[1]!) : undefined;
};

type Raw = unknown[];
const arr = (v: unknown): Raw => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Parses a viewform page. Throws when the page is not a public form (login wall, closed form). */
export function parseForm(html: string, pageUrl: string): GForm {
  const m = /FB_PUBLIC_LOAD_DATA_\s*=\s*([\s\S]*?);\s*<\/script>/.exec(html);
  if (!m) throw new Error(/accounts\.google\.com|ServiceLogin/.test(html) ? "форма требует входа в аккаунт Google" : "это не страница Google Формы (или форма закрыта)");
  const data = JSON.parse(m[1]!) as Raw;
  const body = arr(data[1]);
  const unsupported: string[] = [];
  const questions: GFormQuestion[] = [];
  let pages = 1;
  for (const q of arr(body[1]) as Raw[]) {
    const type = Number(q[3]);
    const title = str(q[1]).replace(/\s+/g, " ").trim();
    if (type === 8) {
      pages++;
      continue;
    }
    if ([6, 11, 12].includes(type)) continue; // title, image, video blocks
    const entries = arr(q[4]) as Raw[];
    const e = entries[0] ?? [];
    const required = e[2] === 1;
    if (type === 7 && entries.length) {
      // Grid: every row is its own entry (radio per row, checkboxes when the grid allows several per row).
      for (const row of entries) {
        const label = str(arr(row[3])[0]).trim();
        const multi = arr(row[11])[0] === 1;
        questions.push({ entry: String(row[0]), title: `${title} - ${label}`, kind: multi ? "checkbox" : "radio", options: (arr(row[1]) as Raw[]).map((o) => str(o[0])), required: row[2] === 1 });
      }
      continue;
    }
    if (![0, 1, 2, 3, 4, 5].includes(type) || entries.length !== 1) {
      if (required) unsupported.push(`обязательный вопрос «${title}» (тип ${type}) не умею заполнять`);
      continue;
    }
    const opts = (arr(e[1]) as Raw[]).filter((o) => o[4] !== 1);
    if ((arr(e[1]) as Raw[]).some((o) => o[2] !== null && o[2] !== undefined)) unsupported.push(`вопрос «${title}»: ответ ведёт на другую страницу формы`);
    const numeric = arr(arr(e[4])[0])[0] === 1;
    const kind: GFormQuestion["kind"] = type === 2 || type === 5 ? "radio" : type === 3 ? "select" : type === 4 ? "checkbox" : numeric ? "number" : "text";
    questions.push({ entry: String(e[0]), title, kind, options: opts.map((o) => str(o[0])), required });
  }
  const action = attr(/<form\b[^>]*>/i.exec(html)?.[0] ?? "", "action") ?? pageUrl.replace(/viewform.*$/, "formResponse");
  const hidden: Record<string, string> = {};
  for (const tag of html.match(/<input\b[^>]*type="hidden"[^>]*>/gi) ?? []) {
    const name = attr(tag, "name");
    if (name) hidden[name] = attr(tag, "value") ?? "";
  }
  if (!questions.length && !unsupported.length) unsupported.push("в форме нет вопросов, которые можно заполнить");
  return {
    id: formKey(pageUrl),
    action,
    viewUrl: pageUrl,
    title: str(data[3]).trim(),
    description: str(body[0]).trim(),
    questions,
    hidden,
    pages,
    needsEmail: /name="emailAddress"/.test(html),
    unsupported,
  };
}

/** Reading is safe to repeat (forms.gle times out about every other connection on the Pi), submitting never is. */
export async function fetchForm(url: string, attempts = 4): Promise<GForm> {
  const target = viewUrl(url);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await httpFetch(target, { headers: { accept: "text/html", "accept-language": "ru,en;q=0.8" } });
      if (!res.ok) throw new Error(`GET ${target} -> HTTP ${res.status}`);
      return parseForm(await res.text(), res.url || target);
    } catch (e) {
      last = e;
      if (e instanceof SyntaxError || /форм/.test(String((e as Error).message))) throw e; // a page we read, not a network error
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  const c = (last as { cause?: { code?: string } })?.cause?.code;
  throw new Error(`${(last as Error).message}${c ? ` (${c})` : ""} после ${attempts} попыток`);
}

/** The form's questions in the shape the questionnaire answerer takes (idx = position in `form.questions`). */
export const formQuestions = (form: GForm): Question[] =>
  form.questions.map((q, idx) => ({ idx, text: q.title, kind: q.kind, ...(q.options.length ? { options: q.options } : {}), required: q.required }));

/** One answer as the values to submit (none = left empty). */
export function answerValues(q: GFormQuestion, a: Answer | undefined): string[] {
  if (!a) return [];
  if (q.kind === "radio" || q.kind === "select") {
    const v = a.option_idx === undefined ? undefined : q.options[a.option_idx];
    return v ? [v] : [];
  }
  if (q.kind === "checkbox") return (a.option_idxs ?? []).flatMap((i) => (q.options[i] ? [q.options[i]!] : []));
  const t = (a.text ?? "").trim();
  return t ? [t] : [];
}

/** Required questions without an answer: filling cannot go on, the human answers. */
export function missingRequired(form: GForm, answers: Answer[]): string[] {
  return form.questions.filter((q, idx) => q.required && !answerValues(q, answers.find((a) => a.idx === idx)).length).map((q) => q.title);
}

export function buildBody(form: GForm, answers: Answer[], email = ""): URLSearchParams {
  const body = new URLSearchParams();
  form.questions.forEach((q, idx) => {
    for (const v of answerValues(q, answers.find((a) => a.idx === idx))) body.append(`entry.${q.entry}`, v);
  });
  for (const [k, v] of Object.entries(form.hidden)) if (!body.has(k) && (!k.startsWith("entry.") || k.endsWith("_sentinel"))) body.set(k, v);
  body.set("fvv", form.hidden.fvv ?? "1");
  // All pages go in one request: with no branching the history is simply 0..n-1.
  body.set("pageHistory", Array.from({ length: form.pages }, (_, i) => i).join(","));
  if (form.needsEmail && email) body.set("emailAddress", email);
  return body;
}

const RECORDED = /freebirdFormviewerViewResponseConfirmationMessage|Ответ записан|Your response has been recorded|response has been recorded/i;

export async function submitForm(form: GForm, answers: Answer[], email = ""): Promise<void> {
  const res = await httpFetch(form.action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: form.viewUrl, origin: "https://docs.google.com", accept: "text/html" },
    body: buildBody(form, answers, email).toString(),
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`POST formResponse -> HTTP ${res.status}`);
  if (!RECORDED.test(html)) throw new Error("Google не подтвердил ответ (форма вернулась с ошибкой валидации?)");
}
