// Pure parsers for hh's page model: <template id="HH-Lux-InitialState">{json}</template>.
// Exact key names are NOT verified against live hh; every parser tries several candidate paths and
// then falls back to a recursive search for objects with telltale keys, and reports `matchedPath`
// so recordings can confirm (or correct) the guesses.
import type { Card, Question, ThreadState } from "@sgz/shared";
import { HH_CHAT_ORIGIN, HH_ORIGIN } from "./urls.js";
import { type Salary, salaryFromCompensation } from "./salary.js";

export type State = Record<string, unknown>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/** Returns the parsed InitialState JSON or null when the template is absent/unparseable. */
export const extractInitialState = (html: string): State | null => {
  const m = /<template[^>]*id="HH-Lux-InitialState"[^>]*>([\s\S]*?)<\/template>/i.exec(html);
  if (!m?.[1]) return null;
  const raw = m[1].trim();
  for (const candidate of [raw, decodeEntities(raw)]) {
    try {
      const v: unknown = JSON.parse(candidate);
      if (isObj(v)) return v;
    } catch {
      /* try next */
    }
  }
  return null;
};

/** get(obj, "a.b[0].c") — dots and [n] indexes; undefined when any segment is missing. */
export const get = (obj: unknown, path: string): unknown => {
  if (!path) return obj;
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (typeof cur === "object") cur = (cur as Obj)[p];
    else return undefined;
  }
  return cur;
};

/** Depth-first search for objects satisfying `pred`; returns [value, path] pairs (path in get() syntax). */
export const findObjects = (root: unknown, pred: (o: Obj, path: string) => boolean, opts?: { limit?: number; maxDepth?: number }): { value: Obj; path: string }[] => {
  const limit = opts?.limit ?? 50;
  const maxDepth = opts?.maxDepth ?? 14;
  const out: { value: Obj; path: string }[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, path: string, depth: number): void => {
    if (out.length >= limit || depth > maxDepth || v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    const o = v as Obj;
    if (pred(o, path)) out.push({ value: o, path });
    for (const k of Object.keys(o)) walk(o[k], path ? `${path}.${k}` : k, depth + 1);
  };
  walk(root, "", 0);
  return out;
};

const firstArray = (state: unknown, paths: string[], elemPred: (o: Obj) => boolean): { arr: Obj[]; path: string } | null => {
  for (const p of paths) {
    const v = get(state, p);
    if (Array.isArray(v) && v.length > 0 && v.every(isObj) && v.some(elemPred)) return { arr: v as Obj[], path: p };
  }
  return null;
};

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const bool = (v: unknown): boolean => v === true || v === "true" || v === 1;
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = get(o, k);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};

/** Strips tags and collapses whitespace; keeps list items/paragraph breaks as newlines. */
export const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<\s*(br|\/p|\/li|\/div|\/h\d|\/tr)\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

// ---------------------------------------------------------------- search

const SEARCH_PATHS = ["vacancySearchResult.vacancies", "vacancySearch.vacancies", "searchResult.vacancies", "vacancySearchResult.items", "vacancies"];
const looksLikeVacancy = (o: Obj): boolean => ("vacancyId" in o || ("id" in o && "links" in o)) && typeof o.name === "string";

export interface ParsedSearch {
  cards: Card[];
  matchedPath: string | null;
  totalPages: number | null;
}

const vacancyIdOf = (o: Obj): string => str(pick(o, "vacancyId", "id", "vacancy_id"));

const companyNameOf = (o: Obj): string => str(pick(o, "company.name", "company.visibleName", "employer.name", "companyName", "employerName"));

const cardFrom = (o: Obj): Card | null => {
  const id = vacancyIdOf(o);
  if (!/^\d+$/.test(id)) return null;
  const url = str(pick(o, "links.desktop", "alternate_url", "url")) || `${HH_ORIGIN}/vacancy/${id}`;
  return {
    externalId: id,
    url: url.split("?")[0] ?? url,
    title: str(o.name),
    company: companyNameOf(o),
    salaryRaw: salaryRawOf(o),
  };
};

const salaryRawOf = (o: Obj): string => {
  const comp = pick(o, "compensation", "salary");
  if (isObj(comp)) {
    const s = salaryFromCompensation(comp);
    if (s.from || s.to) return formatRange(s, bool(comp.gross));
  }
  return str(pick(o, "compensationText", "salaryText"));
};

const formatRange = (s: Salary, wasGross: boolean): string => {
  // salaryFromCompensation already converted gross→net, so the raw string must not say «до вычета».
  const cur = s.currency === "RUR" ? "₽" : s.currency;
  const parts: string[] = [];
  if (s.from) parts.push(`от ${s.from}`);
  if (s.to) parts.push(`до ${s.to}`);
  return `${parts.join(" ")} ${cur}${wasGross ? " (net)" : ""}`.trim();
};

export const parseSearch = (state: State | null): ParsedSearch => {
  if (!state) return { cards: [], matchedPath: null, totalPages: null };
  let hit = firstArray(state, SEARCH_PATHS, looksLikeVacancy);
  if (!hit) {
    const found = findObjects(state, (o) => Array.isArray(o.vacancies) && (o.vacancies as unknown[]).some((v) => isObj(v) && looksLikeVacancy(v)), { limit: 1 });
    const f = found[0];
    if (f) hit = { arr: (f.value.vacancies as unknown[]).filter(isObj), path: `${f.path}.vacancies` };
  }
  if (!hit) return { cards: [], matchedPath: null, totalPages: null };
  const cards = hit.arr.map(cardFrom).filter((c): c is Card => c !== null);
  const pagesRaw = pick(state, "vacancySearchResult.paging.pages", "vacancySearchResult.totalPages", "vacancySearchResult.paging.total");
  const totalPages = Array.isArray(pagesRaw) ? pagesRaw.length : typeof pagesRaw === "number" ? pagesRaw : null;
  return { cards, matchedPath: hit.path, totalPages };
};

// ---------------------------------------------------------------- vacancy

const VACANCY_PATHS = ["vacancyView", "vacancy", "vacancyPage.vacancy", "vacancyView.vacancy"];
const looksLikeVacancyView = (o: Obj): boolean => typeof o.name === "string" && ("vacancyId" in o || "id" in o) && ("description" in o || "hasTest" in o || "responseLetterRequired" in o);

export interface ParsedVacancy {
  externalId: string;
  url: string;
  title: string;
  company: string;
  salary: Salary;
  descriptionText: string;
  hasTest: boolean;
  requiresLetter: boolean;
  area: string;
  workFormat: string;
  publishedAt: string | null;
  archived: boolean;
  alreadyApplied: boolean;
}

const workFormatOf = (o: Obj): string => {
  const wf = pick(o, "workFormat", "workFormats");
  if (Array.isArray(wf)) return wf.map((x) => (isObj(x) ? str(pick(x, "name", "id")) : str(x))).filter(Boolean).join(", ");
  if (isObj(wf)) return str(pick(wf, "name", "id"));
  return str(pick(o, "workSchedule.name", "workScheduleByDays[0].name", "schedule.name", "employment.name"));
};

const publishedAtOf = (o: Obj): string | null => {
  const v = pick(o, "publicationDate", "publicationTime.@timestamp", "publicationTime", "publishedAt", "published_at");
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  return typeof v === "string" ? v : null;
};

export const parseVacancy = (state: State | null): { vacancy: ParsedVacancy | null; matchedPath: string | null } => {
  if (!state) return { vacancy: null, matchedPath: null };
  let o: Obj | null = null;
  let matchedPath: string | null = null;
  for (const p of VACANCY_PATHS) {
    const v = get(state, p);
    if (isObj(v) && looksLikeVacancyView(v)) {
      o = v;
      matchedPath = p;
      break;
    }
  }
  if (!o) {
    const f = findObjects(state, looksLikeVacancyView, { limit: 1 })[0];
    if (f) {
      o = f.value;
      matchedPath = f.path;
    }
  }
  if (!o) return { vacancy: null, matchedPath: null };
  const id = vacancyIdOf(o);
  const responseInfo = pick(o, "responseInfo", "responseStatus", "userResponse");
  const alreadyApplied =
    (isObj(responseInfo) && (bool(responseInfo.responded) || bool(responseInfo.isResponded) || Boolean(pick(responseInfo, "topicId", "negotiationId", "response.id")))) ||
    bool(pick(o, "responded", "hasResponse", "isResponded")) ||
    bool(pick(state, "vacancyResponseStatus.responded", "userResponses.responded"));
  const test = pick(o, "test", "vacancyTest");
  const hasTest = bool(pick(o, "hasTest", "has_test")) || (isObj(test) && (bool(test.required) || bool(test.id))) || bool(test);
  const requiresLetter = bool(pick(o, "responseLetterRequired", "response_letter_required", "responseLetter.required", "letterRequired"));
  const status = pick(o, "status", "state");
  const archived = bool(pick(o, "archived", "isArchived", "archive")) || (isObj(status) && bool(status.archived)) || (typeof status === "string" && /archiv/i.test(status));
  const description = str(pick(o, "description", "descriptionHtml", "branded_description"));
  return {
    matchedPath,
    vacancy: {
      externalId: id,
      url: (str(pick(o, "links.desktop", "alternate_url")) || `${HH_ORIGIN}/vacancy/${id}`).split("?")[0] ?? "",
      title: str(o.name),
      company: companyNameOf(o),
      salary: salaryFromCompensation(pick(o, "compensation", "salary")),
      descriptionText: htmlToText(description),
      hasTest,
      requiresLetter,
      area: str(pick(o, "area.name", "address.city", "area")),
      workFormat: workFormatOf(o),
      publishedAt: publishedAtOf(o),
      archived,
      alreadyApplied,
    },
  };
};

// ---------------------------------------------------------------- resumes

const RESUME_PATHS = ["applicantResumes", "resumeList.resumes", "resumeList", "resumes", "applicant.resumes", "applicantResumes.resumes"];
const HASH_RE = /^[0-9a-f]{20,40}$/i;
const unwrap = (o: Obj): Obj => (isObj(o._attributes) ? { ...(o._attributes as Obj), ...o } : o);
const looksLikeResume = (o: Obj): boolean => {
  const u = unwrap(o);
  return typeof u.hash === "string" && HASH_RE.test(u.hash) && (typeof u.title === "string" || Array.isArray(u.title));
};

export interface ParsedResume {
  hhResumeId: string;
  title: string;
  url: string;
  updatedAt: string | null;
}

const resumeTitleOf = (u: Obj): string => {
  const t = u.title;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    const first = t[0];
    return isObj(first) ? str(pick(first, "string", "value", "name")) : str(first);
  }
  return "";
};

export const parseResumes = (state: State | null): { resumes: ParsedResume[]; matchedPath: string | null } => {
  if (!state) return { resumes: [], matchedPath: null };
  let hit = firstArray(state, RESUME_PATHS, looksLikeResume);
  if (!hit) {
    const found = findObjects(state, looksLikeResume, { limit: 100 });
    if (found.length) hit = { arr: found.map((f) => f.value), path: found[0]!.path.replace(/\[\d+\]$/, "") };
  }
  if (!hit) return { resumes: [], matchedPath: null };
  const seen = new Set<string>();
  const resumes: ParsedResume[] = [];
  for (const raw of hit.arr) {
    if (!looksLikeResume(raw)) continue;
    const u = unwrap(raw);
    const hash = str(u.hash);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const upd = pick(u, "updated", "updatedAt", "lastChangeTime", "update_at");
    resumes.push({
      hhResumeId: hash,
      title: resumeTitleOf(u),
      url: str(pick(u, "url", "links.desktop")) || `${HH_ORIGIN}/resume/${hash}`,
      updatedAt: typeof upd === "number" ? new Date(upd < 1e12 ? upd * 1000 : upd).toISOString() : typeof upd === "string" ? upd : null,
    });
  }
  return { resumes, matchedPath: hit.path };
};

// ---------------------------------------------------------------- negotiations

const NEGOTIATION_PATHS = ["applicantNegotiations.topicList", "applicantNegotiations.list", "applicantNegotiations.topics", "negotiations.topicList", "negotiationsList", "topicList"];
const looksLikeTopic = (o: Obj): boolean => ("vacancyId" in o || isObj(o.vacancy)) && ("id" in o || "topicId" in o) && ("state" in o || "lastState" in o || "status" in o);

export interface ParsedThread {
  negotiationId: string;
  chatUrl: string;
  unread: boolean;
  employer: string;
  state: string; // raw hh state as found
  threadState: ThreadState;
  vacancyExternalId: string | null;
  vacancyTitle: string;
  isBot: boolean;
}

/** Maps hh state ids/names (INVITATION, DISCARD, RESPONSE, «Приглашение», «Отказ»…) to ThreadState. */
export const mapNegotiationState = (raw: string, viewed = false): ThreadState => {
  const s = raw.toLowerCase();
  if (/invit|приглаш/.test(s)) return "invited";
  if (/discard|reject|отказ/.test(s)) return "rejected";
  if (/archiv|архив/.test(s)) return "archived";
  if (/просмотрено|viewed/.test(s) && !/не просмотрено|not viewed/.test(s)) return "viewed";
  return viewed ? "viewed" : "new";
};

export const parseNegotiations = (state: State | null): { threads: ParsedThread[]; matchedPath: string | null } => {
  if (!state) return { threads: [], matchedPath: null };
  let hit = firstArray(state, NEGOTIATION_PATHS, looksLikeTopic);
  if (!hit) {
    const found = findObjects(state, looksLikeTopic, { limit: 200 });
    if (found.length) hit = { arr: found.map((f) => f.value), path: found[0]!.path.replace(/\[\d+\]$/, "") };
  }
  if (!hit) return { threads: [], matchedPath: null };
  const threads: ParsedThread[] = [];
  for (const o of hit.arr) {
    if (!looksLikeTopic(o)) continue;
    const id = str(pick(o, "id", "topicId"));
    if (!id) continue;
    const stateRaw = pick(o, "state.name", "state.id", "state", "lastState.name", "lastState", "status.name", "status");
    const stateStr = isObj(stateRaw) ? str(pick(stateRaw, "name", "id")) : str(stateRaw);
    const viewed = bool(pick(o, "viewedByOpponent", "viewed", "isViewed", "employerViewed"));
    const unreadCount = pick(o, "unreadCount", "unreadMessagesCount");
    const unread = bool(pick(o, "hasUnreadMessages", "hasNewMessages", "unread", "isUnread")) || (typeof unreadCount === "number" && unreadCount > 0);
    const chatId = str(pick(o, "chatId", "chat.id", "chatik.chatId"));
    const chatUrl = str(pick(o, "chatUrl", "chat.url", "links.chat")) || (chatId ? `${HH_CHAT_ORIGIN}/chat/${chatId}` : `${HH_ORIGIN}/applicant/negotiations/item?id=${id}`);
    const vacancyId = str(pick(o, "vacancyId", "vacancy.id", "vacancy.vacancyId"));
    threads.push({
      negotiationId: id,
      chatUrl,
      unread,
      employer: str(pick(o, "employer.name", "employerName", "vacancy.company.name", "company.name", "vacancy.employer.name")),
      state: stateStr,
      threadState: mapNegotiationState(stateStr, viewed),
      vacancyExternalId: /^\d+$/.test(vacancyId) ? vacancyId : null,
      vacancyTitle: str(pick(o, "vacancy.name", "vacancyName", "name")),
      isBot: bool(pick(o, "isBot", "hasBot", "chatBot", "vacancy.hasChatBot", "employer.hasChatBot")),
    });
  }
  return { threads, matchedPath: hit.path };
};

// ---------------------------------------------------------------- chat (chatik)

const CHAT_PATHS = ["chatik.messages", "chat.messages", "messages", "chatik.chat.messages", "chatik.currentChat.messages"];
const looksLikeMessage = (o: Obj): boolean => typeof pick(o, "text", "body", "message") === "string" && ("author" in o || "isMine" in o || "participantId" in o || "sender" in o || "direction" in o);

export interface ParsedChatMessage {
  hhMessageId: string | null;
  direction: "in" | "out";
  author: "employer" | "bot" | "me";
  text: string;
  isQuestion: boolean;
}

export interface ParsedChat {
  messages: ParsedChatMessage[];
  survey: Question[];
  employer: string;
  vacancyExternalId: string | null;
  matchedPath: string | null;
}

const messageFrom = (o: Obj): ParsedChatMessage => {
  const author = pick(o, "author", "sender");
  const authorType = isObj(author) ? str(pick(author, "type", "role", "participantType")).toLowerCase() : str(author).toLowerCase();
  const mine = bool(pick(o, "isMine", "mine", "own")) || /applicant|me|self/.test(authorType) || pick(o, "direction") === "out";
  const isBot = bool(pick(o, "isBot", "fromBot")) || /bot/.test(authorType) || (isObj(author) && bool(author.isBot));
  const text = str(pick(o, "text", "body", "message"));
  return {
    hhMessageId: str(pick(o, "id", "messageId")) || null,
    direction: mine ? "out" : "in",
    author: mine ? "me" : isBot ? "bot" : "employer",
    text,
    isQuestion: !mine && /\?/.test(text),
  };
};

const questionsFrom = (arr: unknown[]): Question[] =>
  arr.filter(isObj).map((q, i) => {
    const opts = pick(q, "options", "answers", "choices");
    const options = Array.isArray(opts) ? opts.map((x) => (isObj(x) ? str(pick(x, "text", "name", "label", "value")) : str(x))).filter(Boolean) : undefined;
    const typeRaw = str(pick(q, "type", "kind", "answerType")).toLowerCase();
    const multi = bool(pick(q, "multiple", "multiSelect")) || /multi|checkbox/.test(typeRaw);
    let kind: Question["kind"] = "text";
    if (options && options.length) kind = multi ? "checkbox" : "radio";
    else if (/number|numeric/.test(typeRaw)) kind = "number";
    else if (/file/.test(typeRaw)) kind = "file";
    const out: Question = { idx: i, text: str(pick(q, "text", "question", "title", "name")), kind, required: bool(pick(q, "required", "isRequired")) };
    if (options && options.length) out.options = options;
    return out;
  });

export const parseChat = (state: State | null): ParsedChat => {
  const empty: ParsedChat = { messages: [], survey: [], employer: "", vacancyExternalId: null, matchedPath: null };
  if (!state) return empty;
  let hit = firstArray(state, CHAT_PATHS, looksLikeMessage);
  if (!hit) {
    const found = findObjects(state, (o) => Array.isArray(o.messages) && (o.messages as unknown[]).some((m) => isObj(m) && looksLikeMessage(m)), { limit: 1 });
    const f = found[0];
    if (f) hit = { arr: (f.value.messages as unknown[]).filter(isObj), path: `${f.path}.messages` };
  }
  const messages = hit ? hit.arr.filter(looksLikeMessage).map(messageFrom) : [];
  const surveyObj = findObjects(state, (o) => Array.isArray(pick(o, "questions")) && (pick(o, "questions") as unknown[]).some((q) => isObj(q) && ("options" in q || "answers" in q || "text" in q)), { limit: 1 })[0];
  const survey = surveyObj ? questionsFrom(surveyObj.value.questions as unknown[]) : [];
  const vac = findObjects(state, (o) => ("vacancyId" in o || "vacancy" in o) && !looksLikeMessage(o), { limit: 1 })[0];
  const vacancyId = vac ? str(pick(vac.value, "vacancyId", "vacancy.id", "vacancy.vacancyId")) : "";
  const employer = str(pick(state, "chatik.employer.name", "chat.employer.name", "employer.name")) || (vac ? str(pick(vac.value, "employer.name", "vacancy.company.name", "company.name")) : "");
  return { messages, survey, employer, vacancyExternalId: /^\d+$/.test(vacancyId) ? vacancyId : null, matchedPath: hit?.path ?? (surveyObj ? surveyObj.path : null) };
};
