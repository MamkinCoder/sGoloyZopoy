// A vacancy the LLM turned down only for a few missing skills: the seeker is asked in her topic whether she has them
// («Java: есть опыт?»). All «есть» → the vacancy is applied to (stage force:<id>); any «нет» → it stays skipped, and
// the answers are kept as KB tag statuses, so later decisions know them (same store as the skill questions).
import { notifierFor, RunBusyError, tagIs, type Notifier, type RunService, type Store, type TapReply, type TgButton, type User, type Vacancy } from "@sgz/shared";
import { escapeHtml } from "../notify/format.js";
import { syncProfileSkills } from "../kb/write.js";

/** At most this many questions per decide stage: a bad batch must not flood the topic. */
export const MAX_ASKS = 3;
const MAX_SKILLS = 3;

interface Ask {
  skills: string[];
  answers: (boolean | null)[];
  title: string;
  messageId: number | null;
}
const key = (appId: number) => `skill_ask:${appId}`;

export const skillAskCallback = (appId: number, i: number, yes: boolean) => `ms:${appId}:${i}:${yes ? "y" : "n"}`;
export function parseSkillAskCallback(data: string): { appId: number; i: number; yes: boolean } | null {
  const m = /^ms:(\d+):(\d+):([yn])$/.exec(data);
  return m ? { appId: Number(m[1]), i: Number(m[2]), yes: m[3] === "y" } : null;
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
    a.answers[i] === null ? [[{ text: `✅ ${s} есть`, data: skillAskCallback(appId, i, true) }, { text: `❌ нет`, data: skillAskCallback(appId, i, false) }]] : [],
  );
  const head = `🤔 <b>${escapeHtml(a.title)}</b> выглядит подходящей, но бот отклонил её из-за навыков. Есть у тебя опыт?`;
  return { text: [head, "", ...lines, footer && `\n${footer}`].filter((x) => x !== "").join("\n"), buttons };
}

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
    return true;
  } catch {
    return false;
  }
}

/** A tap on a skill button: records the tag status, finishes the card and, when every skill is confirmed, applies. */
export async function handleSkillAskTap(store: Store, runner: Pick<RunService, "start">, cb: { appId: number; i: number; yes: boolean }): Promise<TapReply | string> {
  const ask = load(store, cb.appId);
  const row = store.getApplication(cb.appId);
  if (!ask || !row || ask.answers[cb.i] !== null) return "уже отвечено";
  const user = store.listUsers().find((u) => u.id === row.application.userId);
  if (!user) return "пользователь не найден";
  ask.answers[cb.i] = cb.yes;
  const name = ask.skills[cb.i]!;
  const tag = store.listKbTags(user.id).find((t) => tagIs(t, name)) ?? store.upsertKbTag(user.id, { name, status: "unknown" });
  store.setKbTagStatus(tag.id, cb.yes ? "yes" : "no");
  syncProfileSkills(store, user.id);
  store.setSetting(key(cb.appId), JSON.stringify(ask));
  const done = ask.answers.every((a) => a !== null);
  if (!done) return { note: cb.yes ? "✅" : "❌", ...render(ask, cb.appId) };
  if (ask.answers.includes(false)) return { note: "❌", ...render(ask, cb.appId, "Пропускаю эту вакансию.") };
  const source = row.vacancy.source;
  if (source !== "hh" && source !== "habr") return { note: "✅", ...render(ask, cb.appId, `Навыки записал. Этот сайт откликается вручную: ${escapeHtml(row.vacancy.url)}`) };
  try {
    await runner.start({ userSlug: user.slug, source, stage: `force:${cb.appId}`, dryRun: false, limit: 0, trigger: "manual" });
    return { note: "🚀", ...render(ask, cb.appId, "🚀 Откликаюсь.") };
  } catch (e) {
    if (!(e instanceof RunBusyError)) throw e;
    // shortcut: no parking queue for these (queue-cards has one for sends), the panel's «Откликнуться» does the same later.
    return { note: "⏳", ...render(ask, cb.appId, "Навыки записал, но бот сейчас занят: нажми «Откликнуться» у этой вакансии в панели.") };
  }
}
