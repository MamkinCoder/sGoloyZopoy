// Habr Career (career.habr.com) auto-apply over BrowserSession, in the style of hh/client.ts: page data
// from the data-ssr-state / __NUXT_DATA__ JSON, deterministic selectors from the recordings, Stagehand act
// only when a selector is gone. The session is the user's one Chrome profile with Habr cookies injected.
//
// Response flow (from the vacancy page bundle, _pages/vacancies/show, 2026-09): «Откликнуться» POSTs
// /vacancies/<id>/responses at once, with no form before it; the section then turns into «Отклик отправлен»
// with a «Сопроводительное письмо» textarea (name="body") and «Дополнить отклик», which PATCHes the letter
// onto the response. So there is no way to open the form without sending: a dry run never clicks.
import { RunAbortError, Status, normalizeDedup, type ApplyResult, type BrowserSession, type Vacancy } from "@sgz/shared";
import { listUrl } from "../career/ats/sites/habr-career.js";
import type { NewVacancy } from "../runner/filters.js";
import {
  HABR_ORIGIN,
  conversationUrl,
  extractSsrState,
  isLoginUrl,
  loginFromHeader,
  parseConversations,
  parseJsonPage,
  parseListing,
  parseMessages,
  parseVacancyState,
  reviveNuxt,
  vacancyUrl,
  type HabrCard,
  type HabrConversation,
  type HabrMessage,
  type HabrVacancyState,
} from "./state.js";

export const SEL = {
  /** «Откликнуться» in the «Ваш отклик» section (type=submit, but it only calls applyToVacancy). */
  applyButton: "#create-vacancy-response .create-vacancy-response__apply button",
  /** «Отклик отправлен» box of the add-info form shown right after the response is created. */
  sent: ".create-vacancy-response__action-result",
  letter: ['#create-vacancy-response textarea[name="body"]', "#create-vacancy-response textarea"],
  /** «Дополнить отклик»: the only submit of the add-info form. */
  letterSubmit: '#create-vacancy-response form button[type="submit"]',
  chatInput: 'form textarea[placeholder^="Сообщение"]',
  chatSend: 'form:has(textarea[placeholder^="Сообщение"]) button[type="submit"]',
  message: "[data-message-id]",
} as const;

/** Stop applying when Habr's response allowance drops below this. */
export const MIN_RESPONSES_LEFT = 10;

export interface HabrApplyRequest {
  vacancy: Vacancy;
  coverLetter: string;
  dryRun: boolean;
}

export interface HabrApplyResult extends ApplyResult {
  /** createResponse.responsesLeft as last seen, null when unknown. */
  responsesLeft: number | null;
}

export interface HabrClient {
  checkLogin(s: BrowserSession): Promise<boolean>;
  /** One listing page (0-based) of the logged-in vacancy search, newest first. */
  search(s: BrowserSession, query: string, page: number): Promise<{ cards: HabrCard[]; totalPages: number }>;
  fetchVacancy(s: BrowserSession, c: { externalId: string; url: string; title: string; company: string }): Promise<{ vacancy: NewVacancy; state: HabrVacancyState }>;
  apply(s: BrowserSession, req: HabrApplyRequest): Promise<HabrApplyResult>;
  listConversations(s: BrowserSession): Promise<{ conversations: HabrConversation[]; myAvatar: string }>;
  readConversation(s: BrowserSession, login: string): Promise<{ messages: HabrMessage[]; writable: boolean }>;
  sendMessage(s: BrowserSession, login: string, text: string): Promise<void>;
}

export interface HabrClientOptions {
  settleMs?: number;
  confirmTimeoutMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function toNewVacancy(st: HabrVacancyState, url: string): NewVacancy {
  return {
    source: "habr",
    externalId: st.externalId,
    url,
    title: st.title,
    company: st.company,
    salaryFrom: st.salaryFrom,
    salaryTo: st.salaryTo,
    currency: st.currency,
    descriptionText: st.descriptionText,
    hasTest: false,
    requiresLetter: false,
    area: st.area,
    workFormat: st.workFormat,
    publishedAt: st.publishedAt,
    archived: st.archived,
    dedupHash: normalizeDedup(st.company, st.title),
  };
}

export function createHabrClient(opts: HabrClientOptions = {}): HabrClient {
  const settleMs = opts.settleMs ?? 800;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 10_000;
  const log = opts.log ?? (() => {});

  const open = async (s: BrowserSession, url: string, quick = false): Promise<void> => {
    await s.goto(url, { quick });
    const at = await s.url();
    if (isLoginUrl(at)) throw new RunAbortError(Status.FAILED_LOGIN_EXPIRED, `Habr Career redirected to login: ${at}`);
  };
  const firstExisting = async (s: BrowserSession, sels: readonly string[]): Promise<string | null> => {
    for (const sel of sels) if (await s.exists(sel)) return sel;
    return null;
  };
  const readVacancy = async (s: BrowserSession, url: string): Promise<HabrVacancyState | null> => {
    await open(s, url, true);
    return parseVacancyState(extractSsrState(await s.html()));
  };

  const checkLogin: HabrClient["checkLogin"] = async (s) => {
    try {
      await open(s, `${HABR_ORIGIN}/responses`, true);
    } catch (e) {
      if (e instanceof RunAbortError && e.status === Status.FAILED_LOGIN_EXPIRED) return false;
      throw e;
    }
    return loginFromHeader(await s.html()) !== "";
  };

  const search: HabrClient["search"] = async (s, query, page) => {
    await open(s, listUrl(query, page + 1), true);
    const r = parseListing(parseJsonPage(await s.html()));
    log("habr.search", { query, page, count: r.cards.length });
    return r;
  };

  const fetchVacancy: HabrClient["fetchVacancy"] = async (s, c) => {
    const url = c.url || vacancyUrl(c.externalId);
    const st = await readVacancy(s, url);
    if (!st) throw new Error(`no vacancy state on ${url}`);
    return { vacancy: toNewVacancy({ ...st, title: st.title || c.title, company: st.company || c.company }, url), state: st };
  };

  const apply: HabrClient["apply"] = async (s, req) => {
    const id = req.vacancy.externalId;
    const url = req.vacancy.url || vacancyUrl(id);
    let left: number | null = null;
    const done = (status: Status, reasonDetail: string): HabrApplyResult => ({ status, reasonDetail, responsesLeft: left });
    const fail = async (step: string, reasonDetail: string, status: Status = Status.FAILED_UI): Promise<HabrApplyResult> => {
      const snapshotPath = await s.snapshot(`${id}-${step}`).catch(() => undefined);
      log("habr.apply.fail", { id, step, reasonDetail, snapshotPath });
      return { ...done(status, reasonDetail), ...(snapshotPath ? { snapshotPath } : {}) };
    };
    try {
      const st = await readVacancy(s, url);
      if (!st) return fail("state", "no vacancy state on the page");
      left = st.responsesLeft;
      if (st.responded || st.kind === "applied") return done(Status.SKIP_ALREADY_APPLIED, "Habr shows our response already");
      if (st.archived) return done(Status.SKIP_ARCHIVED, "vacancy is archived");
      if (st.placeholder) return done(Status.SKIP_FILTER, `no response form: ${st.placeholder}`);
      if (st.kind !== "direct") return done(Status.SKIP_FILTER, `response kind «${st.kind || "none"}»: not a direct Habr response (external apply)`);
      if (left !== null && left < MIN_RESPONSES_LEFT) return done(Status.SKIP_LIMIT, `only ${left} Habr responses left`);
      if (req.dryRun) {
        return done(Status.SKIP_DRY_RUN, `dry run: «Откликнуться» not clicked (it sends at once); letter of ${req.coverLetter.trim().length} chars would go to «Сопроводительное письмо»`);
      }

      if (await s.exists(SEL.applyButton)) await s.click(SEL.applyButton);
      else {
        const r = await s.act("Нажми кнопку «Откликнуться» в разделе «Ваш отклик»", { cacheKey: "habr.apply.button" });
        if (!r.success) return fail("button", `could not click «Откликнуться»: ${r.message}`);
      }
      await s.waitForSelector(SEL.sent, confirmTimeoutMs);
      await sleep(settleMs);

      const letter = req.coverLetter.trim();
      if (letter) {
        const ta = await firstExisting(s, SEL.letter);
        if (ta) {
          await s.fill(ta, letter);
          if (await s.exists(SEL.letterSubmit)) await s.click(SEL.letterSubmit);
          else await s.act("Нажми кнопку «Дополнить отклик»", { cacheKey: "habr.apply.letter_submit" });
          await s.waitForText("Отклик успешно изменен", confirmTimeoutMs);
          await sleep(settleMs);
        } else log("habr.apply.no_letter_field", { id });
      }

      // Verify from the server's view, not the toast: the reloaded page must carry our response.
      const after = await readVacancy(s, url);
      left = after?.responsesLeft ?? left;
      if (!after?.responded) return fail("confirm", "no response in createResponse after reload", Status.FAILED_NO_CONFIRMATION);
      if (!letter) return done(Status.SENT, "sent");
      return done(Status.SENT, after.responseMessage ? "sent with letter" : "sent, letter NOT saved");
    } catch (e) {
      if (e instanceof RunAbortError) throw e;
      return fail("error", e instanceof Error ? e.message : String(e));
    }
  };

  const listConversations: HabrClient["listConversations"] = async (s) => {
    await open(s, `${HABR_ORIGIN}/conversations`, true);
    const r = parseConversations(reviveNuxt(await s.html()));
    log("habr.conversations", { count: r.conversations.length });
    return { conversations: r.conversations, myAvatar: r.myAvatar };
  };

  const readConversation: HabrClient["readConversation"] = async (s, login) => {
    await open(s, conversationUrl(login));
    await s.waitForSelector(SEL.message, 8_000); // messages are rendered client-side after hydration
    const html = await s.html();
    const me = parseConversations(reviveNuxt(html));
    const banned = me.conversations.find((c) => c.login === login)?.banned ?? false;
    return { messages: parseMessages(html, me.myAvatar), writable: !banned && (await s.exists(SEL.chatInput)) };
  };

  const sendMessage: HabrClient["sendMessage"] = async (s, login, text) => {
    const url = conversationUrl(login);
    if ((await s.url()) !== url) await open(s, url);
    if (!(await s.waitForSelector(SEL.chatInput, 8_000))) throw new Error("sendMessage: no message field");
    await s.fill(SEL.chatInput, text);
    if (await s.exists(SEL.chatSend)) await s.click(SEL.chatSend);
    else {
      const r = await s.act("Нажми кнопку отправки сообщения в чате", { cacheKey: "habr.chat.send" });
      if (!r.success) throw new Error(`sendMessage: could not click send: ${r.message}`);
    }
    if (!(await s.waitForText(text.trim().slice(0, 60), confirmTimeoutMs))) {
      await s.snapshot(`habr-chat-${login}-confirm`).catch(() => "");
      throw new Error("sendMessage: the sent message did not appear");
    }
  };

  return { checkLogin, search, fetchVacancy, apply, listConversations, readConversation, sendMessage };
}
