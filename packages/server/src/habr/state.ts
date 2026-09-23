// Habr Career page data. Rails pages (vacancy, profile) embed their Vue props as
// <script type="application/json" data-ssr-state="true">; the Nuxt pages (/conversations) embed a
// devalue payload in <script id="__NUXT_DATA__">. Chat messages are only in the rendered DOM.
// Shapes confirmed on logged-in recordings, 2026-09 (data/recordings/habr-crawl).
import { decodeEntities, stripHtml } from "../career/http.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const HABR_ORIGIN = "https://career.habr.com";
export const vacancyUrl = (id: string): string => `${HABR_ORIGIN}/vacancies/${id}`;
export const conversationUrl = (login: string): string => `${HABR_ORIGIN}/conversations/${encodeURIComponent(login)}`;
export const isLoginUrl = (url: string): boolean => /account\.habr\.com|\/users\/sign_in|\/login\b/.test(url);

/** The page's data-ssr-state JSON (Rails pages), {} when absent. */
export function extractSsrState(html: string): Obj {
  const m = /<script[^>]*data-ssr-state="true"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) return {};
  try {
    return obj(JSON.parse(m[1].trim().startsWith("{&") ? decodeEntities(m[1]) : m[1]));
  } catch {
    return {};
  }
}

/** Nuxt's __NUXT_DATA__ (devalue: a flat array, objects hold indexes into it) revived to plain JSON. */
export function reviveNuxt(html: string): Obj {
  const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) return {};
  let flat: unknown[];
  try {
    flat = arr(JSON.parse(m[1]));
  } catch {
    return {};
  }
  const WRAPPERS = new Set(["ShallowReactive", "Reactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef"]);
  const memo = new Map<number, unknown>();
  const at = (i: unknown): unknown => {
    if (typeof i !== "number" || i < 0) return null; // negative = undefined/NaN/etc.
    if (memo.has(i)) return memo.get(i);
    const v = flat[i];
    let out: unknown = v;
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && WRAPPERS.has(v[0])) out = v.length > 1 ? at(v[1]) : null;
      else if (typeof v[0] === "string" && /^(Date|Set|Map|Error|BigInt)$/.test(v[0])) out = v[1] ?? null;
      else {
        const a: unknown[] = [];
        memo.set(i, a);
        for (const x of v) a.push(at(x));
        return a;
      }
    } else if (v && typeof v === "object") {
      const o: Obj = {};
      memo.set(i, o);
      for (const [k, x] of Object.entries(v)) o[k] = at(x);
      return o;
    }
    memo.set(i, out);
    return out;
  };
  return obj(at(0));
}

/** JSON the browser shows for an API URL: raw, or wrapped in <pre> with entities. */
export function parseJsonPage(html: string): Obj {
  const t = html.trim();
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(t)?.[1];
  try {
    return obj(JSON.parse(pre !== undefined ? decodeEntities(pre) : t));
  } catch {
    return {};
  }
}

export interface HabrCard {
  externalId: string;
  url: string;
  title: string;
  company: string;
  salaryRaw: string;
  /** Logged-in listing: vacancy.response.kind === "applied". */
  alreadyApplied: boolean;
}

const salaryText = (s: Obj): string => str(s.formatted) || (num(s.from) || num(s.to) ? `${num(s.from) || ""}-${num(s.to) || ""} ${str(s.currency)}` : "");

/** /api/frontend/vacancies?q=… → cards + page count. */
export function parseListing(json: Obj): { cards: HabrCard[]; totalPages: number } {
  const cards = arr(json.list).map((x) => {
    const v = obj(x);
    const id = str(v.id);
    return {
      externalId: id,
      url: vacancyUrl(id),
      title: str(v.title).trim(),
      company: str(obj(v.company).title).trim(),
      salaryRaw: salaryText(obj(v.salary)),
      alreadyApplied: str(obj(v.response).kind) === "applied",
    };
  });
  return { cards: cards.filter((c) => c.externalId), totalPages: num(obj(json.meta).totalPages) };
}

export interface HabrVacancyState {
  externalId: string;
  title: string;
  company: string;
  salaryFrom: number;
  salaryTo: number;
  currency: string;
  descriptionText: string;
  area: string;
  workFormat: string;
  publishedAt: string | null;
  archived: boolean;
  /** vacancy.response.kind: "direct" (apply here), "applied", "guest", ... */
  kind: string;
  /** createResponse.response is set: our response exists. */
  responded: boolean;
  /** createResponse.response.message: the letter attached to our response. */
  responseMessage: string;
  responsesLeft: number | null;
  /** Placeholder shown instead of the response form (e.g. responses closed), "" when none. */
  placeholder: string;
  login: string;
}

/** Vacancy page ssr-state → the fields we use. Null when the page carries no vacancy. */
export function parseVacancyState(state: Obj): HabrVacancyState | null {
  const v = obj(state.vacancy);
  if (!v.id) return null;
  const cr = obj(state.createResponse);
  const resp = cr.response ? obj(cr.response) : null;
  const sal = obj(v.salary);
  const cur = str(sal.currency).toUpperCase();
  const place = state.placeholder ? obj(state.placeholder) : null;
  const left = cr.responsesLeft;
  return {
    externalId: str(v.id),
    title: str(v.title).trim(),
    company: str(obj(v.company).title).trim(),
    salaryFrom: num(sal.from),
    salaryTo: num(sal.to),
    currency: cur === "RUR" ? "RUR" : cur,
    descriptionText: stripHtml(str(v.description)),
    area: str(v.humanCityNames) || arr(v.locations).map((l) => str(obj(l).title)).filter(Boolean).join(", "),
    workFormat: v.remoteWork ? "Можно удалённо" : "",
    publishedAt: str(obj(v.publishedDate).date) || null,
    archived: v.archived === true,
    kind: str(obj(v.response).kind),
    responded: resp !== null,
    responseMessage: resp ? stripHtml(str(resp.messageHtml) || str(resp.message)) : "",
    responsesLeft: typeof left === "number" ? left : null,
    placeholder: place ? str(place.title) || str(place.description) || "placeholder" : "",
    login: str(state.userLogin) || str(obj(state.visitor).login),
  };
}

export interface HabrConversation {
  login: string;
  name: string;
  company: string;
  subtitle: string;
  unread: number;
  lastMessage: { id: string; createdAt: string; isMine: boolean; kind: string; text: string } | null;
  banned: boolean;
}

/** /conversations Nuxt data → the conversation list and the viewer's avatar (to tell our messages apart). */
export function parseConversations(nuxt: Obj): { conversations: HabrConversation[]; myAvatar: string; myLogin: string } {
  const data = obj(nuxt.data);
  const list = obj(data.conversationsListWithSelectedLoginConversation ?? data.conversationsList);
  const me = obj(obj(obj(obj(nuxt.pinia).user).userData).user);
  const conversations = arr(list.conversations).map((x) => {
    const c = obj(x);
    const lm = c.lastMessage ? obj(c.lastMessage) : null;
    return {
      login: str(c.login),
      name: str(c.fullName).trim(),
      company: str(c.companyName).trim(),
      subtitle: str(c.subtitle).trim(),
      unread: num(c.unreadMessagesCount),
      lastMessage: lm ? { id: str(lm.id), createdAt: str(lm.createdAt), isMine: lm.isMine === true, kind: str(lm.kind), text: stripHtml(str(lm.body)) } : null,
      banned: obj(c.banned).status === true,
    };
  });
  return { conversations: conversations.filter((c) => c.login), myAvatar: str(me.avatarUrl), myLogin: str(me.alias) };
}

export interface HabrMessage {
  id: string;
  mine: boolean;
  text: string;
}

/**
 * Messages of an open conversation from the rendered DOM: every `[data-message-id]` block with a
 * `.message-body`; date separators have no body and are skipped. The author is told by the avatar:
 * ours is the viewer's avatar; a block without an avatar continues the previous author's group.
 */
export function parseMessages(html: string, myAvatar: string): HabrMessage[] {
  const out: HabrMessage[] = [];
  const parts = html.split(/<div[^>]*\bdata-message-id="/).slice(1);
  let lastMine = false;
  for (const p of parts) {
    const id = /^(\d+)"/.exec(p)?.[1];
    const body = /class="message-body[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(p)?.[1];
    if (!id || body === undefined) continue;
    const img = /<img[^>]*\ssrc="([^"]+)"/.exec(p.slice(0, p.search(/class="message-body/)))?.[1];
    const mine: boolean = img ? !!myAvatar && img === myAvatar : lastMine;
    lastMine = mine;
    const text = stripHtml(body);
    if (text) out.push({ id, mine, text });
  }
  return out;
}

/** Login of the signed-in user from the header menu (`.menu-head__alias`), "" when signed out. */
export const loginFromHeader = (html: string): string => /class="menu-head__alias"[^>]*>([^<]+)</.exec(html)?.[1]?.trim() ?? "";

export interface HabrExperience {
  id: string;
  company: string;
}

/** /profile/experiences: edit ids and company names, in page order. */
export function parseExperiences(html: string): HabrExperience[] {
  const out: HabrExperience[] = [];
  const re = /href="\/profile\/experiences\/(\d+)\/edit"/g;
  let prevEnd = Math.max(0, html.indexOf('href="/profile/experiences/new"')); // skip the header and menus
  for (const m of html.matchAll(re)) {
    const chunk = html.slice(prevEnd, m.index);
    prevEnd = (m.index ?? 0) + m[0].length;
    // The company name is the last short title-ish text before the edit link: a /companies/<alias> link or a plain div.
    const names = [...chunk.matchAll(/<(?:a href="\/companies\/[^"]+"|div)[^>]*>([^<>]{2,80})<\/(?:a|div)>/g)].map((x) => decodeEntities(x[1]!.trim()));
    const company = names.find((n) => n && !/^\d|Москва|разработчик|Оценить|^Опыт работы$|сервисы Хабра/i.test(n)) ?? "";
    out.push({ id: m[1]!, company });
  }
  return out;
}

export interface HabrResumeState {
  about: string;
  skills: string[];
  qualification: string;
  specializations: string[];
  companies: { title: string; position: string; duration: string; description: string }[];
}

/** Public resume page (/<login>) ssr-state → what the resume shows today. */
export function parseResumeState(state: Obj): HabrResumeState {
  const user = obj(state.user);
  const resume = obj(state.resume);
  return {
    about: stripHtml(str(obj(resume.about).value)),
    skills: arr(user.skills).map((s) => str(obj(s).title)).filter(Boolean),
    qualification: str(user.qualification),
    specializations: arr(user.divisions).map((d) => str(obj(d).title)).filter(Boolean),
    companies: arr(obj(resume.companies).items).map((x) => {
      const c = obj(x);
      const p = obj(arr(c.positions)[0]);
      return { title: str(c.title).trim(), position: str(p.title).trim(), duration: str(p.duration).trim(), description: stripHtml(str(p.message)) };
    }),
  };
}
