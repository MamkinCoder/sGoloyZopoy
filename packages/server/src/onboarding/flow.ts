// Onboarding of a new job seeker as a Telegram conversation: questions → optional CV PDF → profile → hh.ru and Habr
// Career login → resumes → auto-apply on. One state per chat in setting `onboard:<chatId>` (JSON), so a restart
// resumes where the person stopped. The profile written here (queries, directions, verified skills) is what the
// runs search and match by, so applications follow the person's own skills. Plain text in, plain text out; the
// slow parts (resume creation) run in the background and report through the notifier.
import { randomBytes } from "node:crypto";
import { errMessage, notifierFor, type Notifier, type Profile, type Store, type User } from "@sgz/shared";
import { chunkMessage, escapeHtml } from "../notify/format.js";
import type { CVDoc } from "../resume/yaml.js";
import { buildProfile, summaryText, type Answers } from "./build.js";
import type { Connector, Site } from "./connect.js";

export type Step = "name" | "cv" | "role" | "skills" | "years" | "salary" | "place" | "confirm" | "hh_id" | "hh_code" | "habr_id" | "habr_pass" | "habr_review";
export interface Draft {
  profile: Profile;
  cv: CVDoc;
}
export interface State {
  userId: number;
  step: Step;
  a: Partial<Answers>;
  cvText: string;
  draft?: Draft;
  connected: Site[];
  /** The Habr proposal is shown to the person; false while it is still being prepared. */
  proposalReady?: boolean;
}

export interface OnboardDeps {
  store: Pick<Store, "getSetting" | "setSetting" | "upsertUser" | "listUsers" | "getProfile">;
  llm: Parameters<typeof buildProfile>[0];
  notifier: Notifier;
  connector: Pick<Connector, "begin" | "finish">;
  pdfText(buf: Buffer): Promise<string>;
  /** Writes profile (db + yaml + knowledge base) and the base CV of the user. */
  save(user: User, draft: Draft): void;
  /** hh.ru after login: makes sure a resume exists (creates one from the saved profile when the account is new). Resolves to a message for the person. */
  prepareHh(user: User): Promise<string>;
  /** Habr: builds the proposal from the saved profile (nothing is written on Habr) and returns it as text; `apply` writes it. */
  proposeHabr(user: User): Promise<string>;
  /** The proposal already built for this user as text (no new LLM call), null when there is none. */
  showHabr(user: User): string | null;
  applyHabr(user: User): Promise<void>;
  /** The owner has already saved this user's Habr login (`sgz habr-login`, copied to the Pi): no password through Telegram needed. */
  habrLoggedIn(user: User): boolean;
  now(): Date;
}

const key = (chatId: string) => `onboard:${chatId}`;
const SKIP = /^(пропустить|пропуск|skip|нет|-)$/i;
const YES = /^(ок|ok|да|верно|все верно|всё верно|давай|\+)\W*$/i;
const INVITE_TTL_MS = 7 * 86_400_000;
const MAX_PDF = 10 << 20;

const ASK: Record<Step, (s: State) => string> = {
  name: () => "Привет! Я найду работу за тебя: подберу вакансии под твои навыки, сделаю резюме на hh.ru и Хабр Карьере и буду откликаться. Займёт минут 5.\n\nКак тебя зовут?",
  cv: (s) => `Приятно познакомиться, ${s.a.name}! Пришли резюме PDF-файлом, и я возьму опыт и навыки оттуда. Нет резюме - напиши «нет», спрошу сам.`,
  role: () => "Кем хочешь работать? Например: «backend на Go», «frontend React», «DevOps».",
  skills: (s) => `Назови технологии, с которыми реально работал, через запятую. Я не добавлю ничего, чего ты не назвал${s.cvText ? " или чего нет в резюме" : ""}.`,
  years: () => "Сколько лет опыта и где работал последний раз? Одной фразой.",
  salary: () => "Какая зарплата интересна? Например «от 200 тысяч» или «пропустить».",
  place: () => "Откуда ты и какой формат подходит: удалёнка, офис, гибрид? Например «Москва, удалёнка или гибрид».",
  confirm: () => "Всё верно? Напиши «ок», либо «заново».",
  hh_id: () => "Профиль сохранён. Подключаем hh.ru: пришли телефон или e-mail от аккаунта hh, я запрошу код (аккаунта нет - создастся при входе). Или «пропустить».",
  hh_code: () => "Пришли код сюда. Если не пришёл, напиши «заново» или «пропустить».",
  habr_id: () => "Теперь Хабр Карьера: пришли e-mail от аккаунта (аккаунта нет - зарегистрируйся на career.habr.com и пришли e-mail). Если Хабр просит капчу или вход тебе уже подключил владелец, напиши «готово». Или «пропустить».",
  habr_pass: () => "Пришли пароль. Сообщение с ним я сразу удалю, пароль нигде не храню, сохраняется только вход. Или «пропустить».",
  habr_review: () => "Применить это резюме на Хабре? «ок», «пропустить» или «покажи» (пришлю ещё раз).",
};

export function createOnboarding(d: OnboardDeps) {
  const load = (chatId: string): State | null => {
    const raw = d.store.getSetting(key(chatId));
    return raw ? (JSON.parse(raw) as State) : null;
  };
  const save = (chatId: string, s: State): void => d.store.setSetting(key(chatId), JSON.stringify(s));
  const userOf = (s: State): User => {
    const u = d.store.listUsers().find((x) => x.id === s.userId);
    if (!u) throw new Error("пользователь не найден");
    return u;
  };
  // A Telegram message holds 4096 chars; a Habr proposal is longer, so it goes in parts.
  const tell = (user: User, text: string): void => {
    const n = notifierFor(d.notifier, user, "dm");
    void (async () => {
      for (const part of chunkMessage(escapeHtml(text))) await n.ask?.(part, []);
    })().catch(() => undefined);
  };
  const go = (chatId: string, s: State, step: Step, lead = ""): string => {
    save(chatId, { ...s, step });
    return `${lead ? `${lead}\n\n` : ""}${ASK[step]({ ...s, step })}`;
  };
  const finish = (chatId: string, s: State): string => {
    const user = userOf(s);
    d.store.upsertUser({ ...user, active: true, poolExpandPerDay: 3 });
    d.store.setSetting(key(chatId), "");
    const sites = s.connected.map((x) => (x === "hh" ? "hh.ru" : "Хабр Карьера")).join(" и ");
    return sites
      ? `Готово! ${sites}: подключено. Теперь я сам ищу вакансии по твоим навыкам и откликаюсь на подходящие, письма пишу под каждую. Итоги дня пришлю сюда. Команды: /help.`
      : "Профиль готов, но ни hh.ru, ни Хабр не подключены. Подключить можно в любой момент командой /onboard.";
  };

  /** Starts (or restarts) the conversation for a user: a user with a saved profile goes straight to the connections. */
  function start(user: User, chatId: string): string {
    const s: State = { userId: user.id, step: "name", a: {}, cvText: "", connected: [] };
    return go(chatId, s, d.store.getProfile(user.id) ? "hh_id" : "name");
  }

  /** An unfinished onboarding asks its current question again; `restart` (or nothing in progress) starts over. */
  function resume(user: User, chatId: string, restart = false): string {
    const s = load(chatId);
    if (s?.step === "habr_review" && s.proposalReady && !restart) return sendProposal(user, s);
    return s && !restart ? `Продолжаем с того места, где остановились.\n\n${ASK[s.step](s)}` : start(user, chatId);
  }

  /** Redeems an invite («/start <code>» from a chat nobody knows): creates the seeker, inactive until the end. */
  function redeem(chatId: string, text: string): string | null {
    const code = /^\/start\s+([a-f0-9]{8})\s*$/i.exec(text)?.[1]?.toLowerCase();
    const at = code ? Date.parse(d.store.getSetting(`invite:${code}`) ?? "") : NaN;
    if (!code || !(d.now().getTime() - at < INVITE_TTL_MS)) return null;
    if (chatId.startsWith("-")) return "Эта ссылка работает только в личных сообщениях: открой бота и напиши ему /start с кодом там.";
    d.store.setSetting(`invite:${code}`, "");
    const user = d.store.upsertUser({ slug: `u${chatId.replace(/\D/g, "")}`, name: "Новый", tgChatId: chatId, dailyLimitHH: 25, dailyLimitCareer: 10, active: false, allowOtherCountry: false, poolExpandPerDay: 3, opusEnabled: false });
    return start(user, chatId);
  }

  function invite(): string {
    const code = randomBytes(4).toString("hex");
    d.store.setSetting(`invite:${code}`, d.now().toISOString());
    return `Код на 7 дней, одноразовый. Пусть человек напишет боту:\n/start ${code}`;
  }

  async function connect(chatId: string, s: State, site: Site, id: string): Promise<string> {
    const user = userOf(s);
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
    const phone = /^\+?[\d\s()-]{10,}$/.test(id);
    if (!(site === "habr" ? email : email || phone)) return `Не похоже на ${site === "habr" ? "e-mail" : "телефон или e-mail"}. Пришли ещё раз или «пропустить».`;
    try {
      await d.connector.begin(site, user.slug, id.trim());
    } catch (e) {
      return `${errMessage(e)}. Попробуй ещё раз или «пропустить».`;
    }
    return site === "hh" ? go(chatId, s, "hh_code", `Запросил код для ${id.trim()}.`) : go(chatId, s, "habr_pass");
  }

  /** Shows the built Habr proposal again (in parts); true when there was one. */
  function sendProposal(user: User, s: State): string {
    const p = d.showHabr(user);
    if (!p) return ASK.habr_review(s);
    tell(user, `Резюме для Хабра:\n\n${p}\n\n${ASK.habr_review(s)}`);
    return "Присылаю резюме для Хабра, оно длинное, придёт несколькими сообщениями.";
  }

  /** Habr login is in place: the proposal is built in the background and shown for «ок». */
  function habrConnected(chatId: string, s: State, user: User): string {
    const next: State = { ...s, connected: [...s.connected, "habr"], proposalReady: false };
    save(chatId, { ...next, step: "habr_review" });
    void d.proposeHabr(user).then((p) => {
      save(chatId, { ...(load(chatId) ?? next), step: "habr_review", proposalReady: true });
      tell(user, `Резюме для Хабра:\n\n${p}\n\n${ASK.habr_review(next)}`);
    }).catch((e: unknown) => {
      tell(user, "Вошёл на Хабр, но резюме подготовить не вышло. Передал владельцу.");
      void d.notifier.alert(`Онбординг ${user.slug}: резюме Хабр`, errMessage(e)).catch(() => undefined);
      save(chatId, { ...(load(chatId) ?? next), step: "habr_review", proposalReady: true });
    });
    return "Вошёл на Хабр. Готовлю резюме и пришлю на проверку, пара минут.";
  }

  async function text(chatId: string, raw: string, msg?: { remove(): Promise<void> }): Promise<string | null> {
    const s = load(chatId);
    if (!s) return null;
    const t = raw.trim();
    const user = userOf(s);
    switch (s.step) {
      case "name":
        d.store.upsertUser({ ...user, name: t.slice(0, 60) });
        return go(chatId, { ...s, a: { ...s.a, name: t.slice(0, 60) } }, "cv");
      case "cv":
        return SKIP.test(t) ? go(chatId, s, "role") : "Жду PDF-файлом или «нет».";
      case "role":
        return go(chatId, { ...s, a: { ...s.a, role: t } }, "skills");
      case "skills":
        return go(chatId, { ...s, a: { ...s.a, skills: t.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 40) } }, "years");
      case "years":
        return go(chatId, { ...s, a: { ...s.a, years: t } }, "salary");
      case "salary":
        return go(chatId, { ...s, a: { ...s.a, salary: SKIP.test(t) ? "" : t } }, "place");
      case "place": {
        const a = { ...s.a, place: t } as Answers;
        try {
          const draft = await buildProfile(d.llm, a, s.cvText);
          return go(chatId, { ...s, a, draft }, "confirm", `Вот что получилось:\n${summaryText(draft.profile)}`);
        } catch (e) {
          void d.notifier.alert(`Онбординг ${user.slug}: профиль не собрался`, errMessage(e)).catch(() => undefined);
          return "Не получилось собрать профиль, что-то пошло не так на моей стороне. Я уже сообщил владельцу. Напиши место и формат ещё раз через минуту."
        }
      }
      case "confirm":
        if (/^заново/i.test(t)) return go(chatId, { ...s, a: {}, cvText: "", draft: undefined }, "name");
        if (!YES.test(t) || !s.draft) return ASK.confirm(s);
        d.save(user, s.draft);
        return go(chatId, s, "hh_id");
      case "hh_id":
        return SKIP.test(t) ? go(chatId, s, "habr_id") : connect(chatId, s, "hh", t);
      case "hh_code": {
        if (SKIP.test(t)) return go(chatId, s, "habr_id");
        if (/^заново/i.test(t)) return go(chatId, s, "hh_id");
        const code = t.replace(/\s/g, "");
        if (!/^\d{4,8}$/.test(code)) return "Код - это 4-6 цифр. Пришли его ещё раз, «заново» или «пропустить».";
        let ok = false;
        try {
          ok = await d.connector.finish("hh", user.slug, code);
        } catch (e) {
          return `${errMessage(e)}. «заново» или «пропустить».`;
        }
        if (!ok) return "Код не подошёл. Пришли ещё раз, «заново» или «пропустить».";
        void d.prepareHh(user).then((m) => tell(user, m)).catch((e: unknown) => {
          tell(user, "Вошёл на hh.ru, но резюме создать не вышло. Я передал это владельцу, он поможет.");
          void d.notifier.alert(`Онбординг ${user.slug}: резюме hh`, errMessage(e)).catch(() => undefined);
        });
        return go(chatId, { ...s, connected: [...s.connected, "hh"] }, "habr_id", "hh.ru подключён. Резюме готовлю в фоне, напишу, когда будет готово.");
      }
      case "habr_id":
        if (/^(готово|вошёл|вошел)\W*$/i.test(t)) return d.habrLoggedIn(user) ? habrConnected(chatId, s, user) : "Входа на Хабр пока нет. Попроси владельца подключить его или напиши «пропустить».";
        return SKIP.test(t) ? finish(chatId, s) : connect(chatId, s, "habr", t);
      case "habr_pass": {
        if (SKIP.test(t)) return finish(chatId, s);
        await msg?.remove();
        let ok = false;
        try {
          ok = await d.connector.finish("habr", user.slug, t);
        } catch (e) {
          return `${errMessage(e)}. Пришли e-mail заново или «пропустить».`;
        }
        if (!ok) return go(chatId, s, "habr_id", "Не вошёл: e-mail или пароль не подошли.");
        return habrConnected(chatId, s, user);
      }
      case "habr_review":
        if (!s.proposalReady) return "Ещё готовлю резюме, минутку.";
        if (/^(покажи|показать|пришли)/i.test(t)) return sendProposal(user, s);
        if (YES.test(t)) {
          try {
            await d.applyHabr(user);
          } catch (e) {
            return `Не удалось записать на Хабр: ${errMessage(e)}. Напиши «ок», чтобы повторить, или «пропустить».`;
          }
          return finish(chatId, s).replace("Готово!", "Записал резюме на Хабр. Готово!");
        }
        return SKIP.test(t) ? finish(chatId, s) : ASK.habr_review(s);
    }
  }

  async function document(chatId: string, doc: { name: string; size: number; download(): Promise<Buffer> }): Promise<string | null> {
    const s = load(chatId);
    if (!s || s.step === "confirm" || s.step === "hh_code" || s.step === "habr_pass") return s ? "Файл сейчас не нужен." : null;
    if (!/\.pdf$/i.test(doc.name) || doc.size > MAX_PDF) return "Нужен PDF до 10 МБ.";
    let cvText = "";
    try {
      cvText = (await d.pdfText(await doc.download())).slice(0, 30_000);
    } catch (e) {
      return `Не смог прочитать файл (${errMessage(e)}). Пришли другой или напиши «нет».`;
    }
    if (cvText.length < 200) return "В файле почти нет текста (скан?). Пришли PDF с текстом или напиши «нет».";
    const next = { ...s, cvText };
    return s.step === "cv" ? go(chatId, next, "role", "Прочитал резюме.") : (save(chatId, next), "Прочитал резюме, учту его при сборке профиля.");
  }

  return { start, resume, redeem, invite, text, document, active: (chatId: string) => !!load(chatId) };
}
