// Skills in the personal chat with the bot (the group's topic stays the feed of vacancies and per-vacancy skill cards):
//   /pending (/confirm_all_skills)  every skill question still waiting, ONE list for all employers: ✍️ tell the experience
//                                   (the LLM words it into a story), ✅ confirm what is already written, ❌ no such skill.
//                                   The answer resolves the skill in every task that asks it.
//   /skills                         the confirmed skills with what is written under each: add more (LLM rewording),
//                                   edit a story by hand, delete a story or the whole skill, add a skill nobody asked about.
// Callback data `ks:<op>[:<id>]`; the text the bot waits for is setting `skills_wait:<chat>`.
import { tagIs, type KbStory, type KbTag, type LLMClient, type Notifier, type TapReply, type TgButton, type User } from "@sgz/shared";
import { answerTagEverywhere, askStoryText, pendingSkills } from "../agent/chats/review.js";
import type { ChatEnv, ChatStore } from "../agent/chats/env.js";
import { mergeKb, saveMerged } from "../kb/llm.js";
import { applyProfileSkills, syncProfileSkills } from "../kb/write.js";
import { escapeHtml as esc, plural } from "../notify/format.js";
import { notifierFor } from "@sgz/shared";

export interface HubDeps {
  store: ChatStore;
  llm: LLMClient;
  notifier: Notifier;
  /** The agent's env: needed for the pending list (chat tasks); null when the runner is off. */
  chats: ChatEnv | null;
  now(): Date;
  /** A skill got a story (or «-»): vacancy questions waiting for it are settled. */
  afterSkill?(userId: number, tagId: number): Promise<void>;
}

type Wait = { kind: "more"; tagId: number } | { kind: "edit"; storyId: number } | { kind: "newname" };
type Card = { text: string; buttons: TgButton[][] };

const PAGE = 8;
const LIST_PAGE = 10;
const OFF = "агент выключен (SGZ_RUNNER=false): вопросы по навыкам сейчас не копятся";
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const waitKey = (chatId: string) => `skills_wait:${chatId}`;
const cardKey = (userId: number) => `skills_pending_card:${userId}`;

export const skillsCallback = (op: string, id?: number): string => `ks:${op}${id === undefined ? "" : `:${id}`}`;
export function parseSkillsCallback(data: string): { op: string; id: number } | null {
  const m = /^ks:([A-Za-z]+)(?::(\d+))?$/.exec(data);
  return m ? { op: m[1]!, id: m[2] === undefined ? 0 : Number(m[2]) } : null;
}

export function createSkillsHub(d: HubDeps) {
  const { store } = d;
  const iso = () => d.now().toISOString();
  const userOfChat = (chatId: string): User | null => store.listUsers().find((u) => u.tgChatId === chatId) ?? null;
  const dm = (user: User) => notifierFor(d.notifier, user, "dm");
  const nav = (page: number, pages: number, op: string): TgButton[] =>
    pages > 1 ? [{ text: "◀", data: skillsCallback(op, Math.max(0, page - 1)) }, { text: `${page + 1}/${pages}`, data: skillsCallback("nop") }, { text: "▶", data: skillsCallback(op, Math.min(pages - 1, page + 1)) }] : [];

  // ---------------------------------------------------------------- pending skills

  function pendingCard(user: User, page = 0): Card {
    if (!d.chats) return { text: OFF, buttons: [] };
    const items = pendingSkills(d.chats, user.id).sort((a, b) => a.tag.name.localeCompare(b.tag.name));
    if (!items.length) return { text: "Вопросов по навыкам нет, всё отвечено 👍\nВсе подтверждённые навыки: /skills", buttons: [] };
    const pages = Math.ceil(items.length / PAGE);
    const p = Math.min(page, pages - 1);
    const shown = items.slice(p * PAGE, p * PAGE + PAGE);
    const lines = shown.map(({ tag, employers }) => {
      const where = employers.length ? ` - ${cut(employers.slice(0, 2).join(", "), 60)}${employers.length > 2 ? ` и ещё ${employers.length - 2}` : ""}` : "";
      return `• <b>${esc(tag.name)}</b>${where}${tag.storyCount ? ` · историй ${tag.storyCount}` : ""}`;
    });
    const buttons: TgButton[][] = shown.map(({ tag }) => [
      { text: `✍️ ${cut(tag.name, 18)}`, data: skillsCallback("w", tag.id) },
      ...(tag.storyCount ? [{ text: `✅ ${cut(tag.name, 14)}`, data: skillsCallback("y", tag.id) }] : []),
      { text: `❌ ${cut(tag.name, 14)}`, data: skillsCallback("n", tag.id) },
    ]);
    if (pages > 1) buttons.push(nav(p, pages, "pg"));
    return {
      text: `<b>${items.length} ${plural(items.length, ["навык ждёт", "навыка ждут", "навыков ждут"])} ответа</b>\n✍️ расскажи про опыт (оформлю сам), ✅ подтвердить то, что уже записано, ❌ нет такого навыка. Ответ действует сразу во всех вакансиях, где его спрашивали.\n\n${lines.join("\n")}`,
      buttons,
    };
  }

  async function openPending(user: User): Promise<string> {
    const c = pendingCard(user);
    const id = await dm(user).ask?.(c.text, c.buttons);
    if (typeof id === "number") store.setSetting(cardKey(user.id), String(id));
    return "";
  }

  /** The open pending card again as it is now (after a story was saved, an answer given elsewhere). */
  async function refreshPending(userId: number): Promise<void> {
    const user = store.listUsers().find((u) => u.id === userId);
    const id = Number(store.getSetting(cardKey(userId)));
    if (!user || !id) return;
    const c = pendingCard(user);
    await dm(user).edit?.(id, c.text, c.buttons);
  }

  // ---------------------------------------------------------------- skills manager

  const confirmedTags = (userId: number): KbTag[] => store.listKbTags(userId).filter((t) => t.status === "yes");

  function listCard(user: User, page = 0): Card {
    const tags = confirmedTags(user.id);
    const pages = Math.max(1, Math.ceil(tags.length / LIST_PAGE));
    const p = Math.min(page, pages - 1);
    const rows: TgButton[][] = [];
    const shown = tags.slice(p * LIST_PAGE, p * LIST_PAGE + LIST_PAGE);
    for (let i = 0; i < shown.length; i += 2) rows.push(shown.slice(i, i + 2).map((t) => ({ text: `${cut(t.name, 22)} · ${t.storyCount}`, data: skillsCallback("o", t.id) })));
    if (pages > 1) rows.push(nav(p, pages, "l"));
    rows.push([{ text: "➕ Новый навык", data: skillsCallback("new") }]);
    return {
      text: `<b>Твои навыки: ${tags.length}</b> (число - сколько историй записано)\nТапни навык: посмотреть, что записано, дополнить, поправить или убрать.${tags.length ? "" : "\nПока ни одного: добавь первый."}`,
      buttons: rows,
    };
  }

  const storyText = (s: KbStory, i: number): string => {
    const head = [s.title, [s.company, s.period].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    const body = [s.context && cut(s.context, 160), s.did && cut(s.did, 260), s.result && `Итог: ${cut(s.result, 140)}`].filter(Boolean).join(" ");
    return `<b>${i + 1}. ${esc(cut(head, 100))}</b>${s.confirmed ? "" : " (из резюме, не подтверждено)"}\n${esc(body)}`;
  };

  function detailCard(user: User, tagId: number): Card | null {
    const tag = store.listKbTags(user.id).find((t) => t.id === tagId);
    if (!tag) return null;
    const stories = store.listKbStories(user.id, tag.id).slice(0, 6);
    const text = `<b>${esc(tag.name)}</b>${tag.status === "yes" ? " ✅" : ""}\n\n${stories.length ? stories.map(storyText).join("\n\n") : "Историй нет: навык заявлен без описания."}`;
    // One skill = one entry. Several (older imports) can be merged into one; each can be edited or deleted meanwhile.
    const buttons: TgButton[][] = [
      [{ text: "➕ Дополнить", data: skillsCallback("m", tag.id) }, ...(stories.length === 1 ? [{ text: "✏️ Править", data: skillsCallback("e", stories[0]!.id) }] : [])],
      ...(stories.length > 1
        ? [[{ text: "🧩 Свести в одну запись", data: skillsCallback("r", tag.id) }], stories.flatMap((s, i) => [{ text: `✏️ ${i + 1}`, data: skillsCallback("e", s.id) }, { text: `🗑 ${i + 1}`, data: skillsCallback("x", s.id) }])]
        : []),
      [{ text: "🗑 Убрать навык", data: skillsCallback("d", tag.id) }, { text: "◀ К списку", data: skillsCallback("l", 0) }],
    ];
    return { text: cut(text, 3900), buttons };
  }

  /** Removes the skill from the profile entirely: its stories (a story shared with other skills only loses this tag), the claim, the status. */
  function removeSkill(user: User, tag: KbTag): void {
    for (const s of store.listKbStories(user.id, tag.id)) {
      if (s.tags.length <= 1) store.deleteKbStory(s.id);
      else store.saveKbStory({ ...s, tagIds: s.tags.filter((t) => t.id !== tag.id).map((t) => t.id) });
    }
    const p = store.getProfile(user.id);
    if (p) {
      const next = { ...p, verified_skills: p.verified_skills.filter((x) => !tagIs(tag, x)) };
      store.saveProfile(user.id, next);
      applyProfileSkills(store, user.id, next);
    }
    store.setKbTagStatus(tag.id, "unknown");
    syncProfileSkills(store, user.id);
  }

  const companiesOf = (userId: number): string[] => [...new Set(store.listKbStories(userId).map((s) => [s.company, s.period].filter(Boolean).join(", ")).filter(Boolean))];
  const setWait = (chatId: string, w: Wait | null) => store.setSetting(waitKey(chatId), w ? JSON.stringify(w) : "");

  // ---------------------------------------------------------------- taps and text

  const reply = (note: string, c: Card, say?: string): TapReply => ({ note, text: c.text, buttons: c.buttons, ...(say ? { say } : {}) });

  async function tap(data: string, chatId: string): Promise<TapReply | string> {
    const cb = parseSkillsCallback(data);
    const user = userOfChat(chatId);
    if (!cb || !user) return "кнопка устарела";
    const tag = store.listKbTags(user.id).find((t) => t.id === cb.id);
    switch (cb.op) {
      case "nop":
        return "";
      case "pg":
        return reply("", pendingCard(user, cb.id));
      case "l":
        return reply("", listCard(user, cb.id));
      case "w": {
        // The skill's live review waits for the text (the same path as «Дополнить» on a group card).
        const r = d.chats && pendingSkills(d.chats, user.id).find((x) => x.tag.id === cb.id)?.reviews[0];
        if (!tag || !r) return reply("уже отвечено", pendingCard(user));
        store.awaitKbReviewText(r.id, chatId, iso());
        return reply(`Жду рассказ про ${tag.name}`, pendingCard(user), esc(askStoryText(tag.name)));
      }
      case "y":
      case "n": {
        if (!tag || !d.chats) return "кнопка устарела";
        if (cb.op === "y") {
          for (const s of store.listKbStories(user.id, tag.id)) if (!s.confirmed) store.saveKbStory({ ...s, confirmed: true, tagIds: s.tags.map((t) => t.id) });
        }
        await answerTagEverywhere(d.chats, user.id, tag.id, cb.op === "y");
        return reply(cb.op === "y" ? `✅ ${tag.name}` : `❌ ${tag.name}: нет навыка`, pendingCard(user));
      }
      case "o": {
        const c = detailCard(user, cb.id);
        return c ? reply("", c) : "навык не найден";
      }
      case "r": {
        if (!tag) return "навык не найден";
        const existing = store.listKbStories(user.id, tag.id);
        const merged = await mergeKb(d.llm, { tag: tag.name, text: "", companies: companiesOf(user.id), existing });
        if (!merged) return "не получилось свести записи, попробуй ещё раз";
        saveMerged(store, user.id, tag.name, merged, existing);
        return reply("Свёл в одну запись", detailCard(user, tag.id)!);
      }
      case "m":
        if (!tag) return "навык не найден";
        setWait(chatId, { kind: "more", tagId: tag.id });
        return reply("", detailCard(user, tag.id)!, esc(`Напиши ещё про ${tag.name}: где, что делал, какой результат. Я оформлю в историю.`));
      case "e": {
        const s = store.getKbStory(cb.id);
        if (!s || s.userId !== user.id) return "история не найдена";
        setWait(chatId, { kind: "edit", storyId: s.id });
        return reply("Жду новый текст", (s.tags[0] && detailCard(user, s.tags[0].id)) || listCard(user), esc(`Сейчас записано:\n${s.did || s.context || s.title}\n\nПришли новый текст одним сообщением, он заменит «что делал». «отмена» оставит как есть.`));
      }
      case "x": {
        const s = store.getKbStory(cb.id);
        if (!s || s.userId !== user.id) return "история не найдена";
        const t = s.tags[0]?.id;
        store.deleteKbStory(s.id);
        const c = t === undefined ? null : detailCard(user, t);
        return c ? reply("История удалена", c) : "история удалена";
      }
      case "d":
        if (!tag) return "навык не найден";
        return reply("", {
          text: `Убрать <b>${esc(tag.name)}</b> из профиля? Удалю навык и ${tag.storyCount} ${plural(tag.storyCount, ["историю", "истории", "историй"])}. Резюме на hh и Хабре обновятся командой /cvsync.`,
          buttons: [[{ text: "Да, убрать", data: skillsCallback("D", tag.id) }, { text: "Отмена", data: skillsCallback("o", tag.id) }]],
        });
      case "D":
        if (!tag) return "навык не найден";
        removeSkill(user, tag);
        if (d.chats) void refreshPending(user.id).catch(() => undefined);
        return reply(`Убрал ${tag.name}`, listCard(user));
      case "new":
        setWait(chatId, { kind: "newname" });
        return reply("", listCard(user), "Как называется навык? Одним сообщением, например «Kafka».");
      default:
        return "кнопка устарела";
    }
  }

  /** Free text while the bot waits for an experience, a new text of a story or a new skill's name. Null = not ours. */
  async function text(chatId: string, raw: string): Promise<string | null> {
    const stored = store.getSetting(waitKey(chatId));
    const user = userOfChat(chatId);
    if (!stored || !user) return null;
    const wait = JSON.parse(stored) as Wait;
    const t = raw.trim();
    setWait(chatId, null);
    if (wait.kind === "newname") {
      if (!t || t.length > 60 || t.includes("\n")) {
        setWait(chatId, wait);
        return "Название короткое, одной строкой. Пришли ещё раз.";
      }
      const tag = store.upsertKbTag(user.id, { name: t });
      setWait(chatId, { kind: "more", tagId: tag.id });
      return `Напиши, что делал с «${tag.name}»: где, что именно, какой результат. Или «-», чтобы добавить навык без описания.`;
    }
    if (wait.kind === "edit") {
      const s = store.getKbStory(wait.storyId);
      if (!s) return "История не найдена.";
      if (/^отмена$/i.test(t)) return "Оставил как было.";
      store.saveKbStory({ ...s, did: t.slice(0, 1500), confirmed: true, source: "telegram", tagIds: s.tags.map((x) => x.id) });
      return "Сохранил. Резюме на hh и Хабре обновятся командой /cvsync.";
    }
    const tag = store.listKbTags(user.id).find((x) => x.id === wait.tagId);
    if (!tag) return "Навык не найден.";
    if (t === "-") {
      store.setKbTagStatus(tag.id, "yes");
      syncProfileSkills(store, user.id);
      if (d.chats) await answerTagEverywhere(d.chats, user.id, tag.id, true);
      await d.afterSkill?.(user.id, tag.id).catch(() => undefined);
      return `Добавил «${tag.name}» без описания. Резюме обновятся командой /cvsync.`;
    }
    // One entry per skill: the LLM reads what is written and the new text and rewrites them into a single entry.
    const existing = store.listKbStories(user.id, tag.id);
    const merged = await mergeKb(d.llm, { tag: tag.name, text: t, companies: companiesOf(user.id), existing });
    if (!merged) {
      setWait(chatId, wait);
      return `Не получилось собрать запись про ${tag.name}. Напиши подробнее: где, что делал, какой результат.`;
    }
    saveMerged(store, user.id, tag.name, merged, existing);
    if (d.chats) await answerTagEverywhere(d.chats, user.id, tag.id, true);
    await d.afterSkill?.(user.id, tag.id).catch(() => undefined);
    return `Обновил запись про ${tag.name}: ${merged.title}. Посмотреть: /skills. Резюме на hh и Хабре обновятся командой /cvsync.`;
  }

  async function openList(user: User): Promise<string> {
    const c = listCard(user);
    await dm(user).ask?.(c.text, c.buttons);
    return "";
  }

  return { openPending, openList, refreshPending, tap, text, pendingCard, listCard };
}
