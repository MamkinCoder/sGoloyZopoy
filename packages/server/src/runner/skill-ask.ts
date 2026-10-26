// A vacancy the LLM turned down only for a few missing skills: the seeker is asked in her topic whether she has them
// («Java: есть опыт?»). All «есть» → the vacancy is applied to (stage force:<id>, parked until the runner is free);
// any «нет» → it stays skipped. Every answer is kept as a KB tag status, so later decisions know it (same store as the
// skill questions). «✍️» asks for a story in the personal chat; the skills hub saves it into the skill and calls
// `afterSkill`, which counts it as «есть» here.
import { notifierFor, RunBusyError, tagIs, type Notifier, type RunService, type Store, type TapReply, type TgButton, type User, type Vacancy } from "@sgz/shared";
import { escapeHtml } from "../notify/format.js";
import { syncProfileSkills } from "../kb/write.js";

/** At most this many questions per decide stage: a bad batch must not flood the topic. */
export const MAX_ASKS = 3;
const MAX_SKILLS = 3;
const OPEN = "skill_ask_open";
const PARKED = "skill_force_pending";

interface Ask {
  skills: string[];
  answers: (boolean | null)[];
  title: string;
  messageId: number | null;
}
const key = (appId: number) => `skill_ask:${appId}`;
const ids = (store: Pick<Store, "getSetting">, k: string): number[] => (store.getSetting(k) ?? "").split(",").filter(Boolean).map(Number);
const putIds = (store: Pick<Store, "setSetting">, k: string, v: number[]) => store.setSetting(k, [...new Set(v)].join(","));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

type Op = "y" | "n" | "w";
export const skillAskCallback = (appId: number, i: number, op: Op) => `ms:${appId}:${i}:${op}`;
export function parseSkillAskCallback(data: string): { appId: number; i: number; op: Op } | null {
  const m = /^ms:(\d+):(\d+):([ynw])$/.exec(data);
  return m ? { appId: Number(m[1]), i: Number(m[2]), op: m[3] as Op } : null;
}

const load = (store: Pick<Store, "getSetting">, appId: number): Ask | null => {
  try {
    return JSON.parse(store.getSetting(key(appId)) ?? "") as Ask;
  } catch {
    return null;
  }
};

function render(a: Ask, appId: number, footer = ""): { text: string; buttons: TgButton[][] } {
  const lines = a.skills.map((s, i) => `• <b>${escapeHtml(s)}</b> ${a.answers[i] === null ? "?" : a.answers[i] ? "✅ есть" : "❌ нет"}`);
  const buttons = a.skills.flatMap((s, i): TgButton[][] =>
    a.answers[i] === null
      ? [[{ text: `✅ ${cut(s, 14)}`, data: skillAskCallback(appId, i, "y") }, { text: `✍️ ${cut(s, 14)}`, data: skillAskCallback(appId, i, "w") }, { text: `❌ ${cut(s, 14)}`, data: skillAskCallback(appId, i, "n") }]]
      : [],
  );
  const hint = a.answers.includes(null) ? "✅ есть, ✍️ есть, и сейчас расскажу подробнее (допишу в навык), ❌ нет." : "";
  const head = `🤔 <b>${escapeHtml(a.title)}</b> выглядит подходящей, но бот отклонил её из-за навыков. Есть у тебя опыт?`;
  return { text: [head, "", ...lines, hint && `\n${hint}`, footer && `\n${footer}`].filter((x) => x !== "").join("\n"), buttons };
}

const tagOf = (store: Store, userId: number, name: string) => store.listKbTags(userId).find((t) => tagIs(t, name)) ?? store.upsertKbTag(userId, { name, status: "unknown" });

/** Asks about the skills a rejected vacancy lacked; skills already answered (yes / no) are not asked again. Never throws. */
export async function askMissingSkills(store: Store, notifier: Notifier, user: User, vacancy: Pick<Vacancy, "title" | "company">, appId: number, missing: string[]): Promise<boolean> {
  try {
    const tags = store.listKbTags(user.id);
    // «no» is final, «yes» means the model was wrong about the profile: only unknown skills are worth a question.
    const skills = [...new Set(missing.map((s) => s.trim()).filter(Boolean))].filter((s) => !tags.some((t) => tagIs(t, s) && t.status !== "unknown")).slice(0, MAX_SKILLS);
    if (!skills.length || load(store, appId)) return false;
    const ask: Ask = { skills, answers: skills.map(() => null), title: `${vacancy.title} · ${vacancy.company}`, messageId: null };
    const c = render(ask, appId);
    const id = await notifierFor(notifier, user).ask?.(c.text, c.buttons);
    ask.messageId = typeof id === "number" ? id : null;
    store.setSetting(key(appId), JSON.stringify(ask));
    putIds(store, OPEN, [...ids(store, OPEN), appId]);
    return true;
  } catch {
    return false;
  }
}

export interface AskDeps {
  store: Store;
  runner: Pick<RunService, "start" | "active">;
  notifier: Notifier;
}

const startForce = (runner: AskDeps["runner"], slug: string, source: "hh" | "habr", appId: number) => runner.start({ userSlug: slug, source, stage: `force:${appId}`, dryRun: false, limit: 0, trigger: "manual" });

function park(store: Store, appId: number): string {
  putIds(store, PARKED, [...ids(store, PARKED), appId]);
  return "⏳ Бот сейчас занят, откликнусь сам, как освободится.";
}

/** Every skill of the card is answered: all «есть» → apply (parked while a run is active, the autopilot starts it); else skipped. Returns the card footer. */
async function finish(d: AskDeps, ask: Ask, appId: number): Promise<string> {
  putIds(d.store, OPEN, ids(d.store, OPEN).filter((x) => x !== appId));
  if (ask.answers.includes(false)) return "Пропускаю эту вакансию.";
  const row = d.store.getApplication(appId);
  const user = row && d.store.listUsers().find((u) => u.id === row.application.userId);
  if (!row || !user) return "";
  const source = row.vacancy.source;
  if (source !== "hh" && source !== "habr") return `Навыки записал. Этот сайт откликается вручную: ${escapeHtml(row.vacancy.url)}`;
  if (d.runner.active()) return park(d.store, appId);
  try {
    await startForce(d.runner, user.slug, source, appId);
    return "🚀 Откликаюсь.";
  } catch (e) {
    if (e instanceof RunBusyError) return park(d.store, appId);
    throw e;
  }
}

/** The autopilot tick: starts the oldest parked application while the runner is idle. True when a run was started. */
export async function startPendingForce(store: Store, runner: AskDeps["runner"]): Promise<boolean> {
  const list = ids(store, PARKED);
  while (list.length) {
    const appId = list.shift()!;
    putIds(store, PARKED, list);
    const row = store.getApplication(appId);
    const user = row && store.listUsers().find((u) => u.id === row.application.userId);
    const source = row?.vacancy.source;
    if (!row || !user || (source !== "hh" && source !== "habr") || store.hasSentApplication(user.id, row.vacancy.id)) continue;
    try {
      await startForce(runner, user.slug, source, appId);
    } catch (e) {
      putIds(store, PARKED, [appId, ...list]); // still busy: keep it for the next idle minute
      throw e;
    }
    return true;
  }
  return false;
}
export const hasParkedForce = (store: Pick<Store, "getSetting">): boolean => ids(store, PARKED).length > 0;

/** A skill got an answer: records the tag status, saves the card state and finishes the card when it was the last open skill. */
async function settle(d: AskDeps, appId: number, i: number, yes: boolean): Promise<{ ask: Ask; footer: string } | null> {
  const ask = load(d.store, appId);
  const row = d.store.getApplication(appId);
  if (!ask || !row || ask.answers[i] !== null) return null;
  ask.answers[i] = yes;
  const tag = tagOf(d.store, row.application.userId, ask.skills[i]!);
  if (tag.status !== (yes ? "yes" : "no")) d.store.setKbTagStatus(tag.id, yes ? "yes" : "no");
  syncProfileSkills(d.store, row.application.userId);
  d.store.setSetting(key(appId), JSON.stringify(ask));
  const footer = ask.answers.every((a) => a !== null) ? await finish(d, ask, appId) : "";
  return { ask, footer };
}

/** A tap on a skill button. «✍️» sends the question to the personal chat and waits for the story there. */
export async function handleSkillAskTap(d: AskDeps, cb: { appId: number; i: number; op: Op }): Promise<TapReply | string> {
  const ask = load(d.store, cb.appId);
  const row = d.store.getApplication(cb.appId);
  if (!ask || !row || ask.answers[cb.i] !== null) return "уже отвечено";
  const user = d.store.listUsers().find((u) => u.id === row.application.userId);
  if (!user) return "пользователь не найден";
  if (cb.op === "w") {
    if (!user.tgChatId) return "напиши боту в личку, и повтори";
    const name = ask.skills[cb.i]!;
    d.store.setSetting(`skills_wait:${user.tgChatId}`, JSON.stringify({ kind: "more", tagId: tagOf(d.store, user.id, name).id }));
    await notifierFor(d.notifier, user, "dm").ask?.(`✍️ <b>${escapeHtml(name)}</b> для «${escapeHtml(ask.title)}»: напиши одним сообщением, где и что ты делал, какой результат (например «в 2017 настроил X, поднял метрику на 50%»). Я допишу это в навык. «-» - просто есть, без описания.`, []);
    return { note: "Жду рассказ в личке", ...render(ask, cb.appId, "✍️ Жду твой рассказ в личке с ботом.") };
  }
  const r = await settle(d, cb.appId, cb.i, cb.op === "y");
  if (!r) return "уже отвечено";
  return { note: cb.op === "y" ? "✅" : "❌", ...render(r.ask, cb.appId, r.footer) };
}

/** The skills hub saved a story (or «-») into the skill: counts as «есть» on every open card that asks for it. */
export async function afterSkill(d: AskDeps, userId: number, tagId: number): Promise<void> {
  const tag = d.store.listKbTags(userId).find((t) => t.id === tagId);
  if (!tag) return;
  const user = d.store.listUsers().find((u) => u.id === userId);
  for (const appId of ids(d.store, OPEN)) {
    const ask = load(d.store, appId);
    const row = d.store.getApplication(appId);
    const i = ask?.skills.findIndex((s) => tagIs(tag, s)) ?? -1;
    if (!ask || !row || row.application.userId !== userId || i < 0 || ask.answers[i] !== null) continue;
    const r = await settle(d, appId, i, true).catch(() => null);
    if (r && user && r.ask.messageId !== null) {
      const c = render(r.ask, appId, r.footer);
      await notifierFor(d.notifier, user).edit?.(r.ask.messageId, c.text, c.buttons).catch(() => undefined);
    }
  }
}
