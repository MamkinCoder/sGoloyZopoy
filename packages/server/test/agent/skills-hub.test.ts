// The skills hub of the personal chat: all pending skill questions in one list (an answer resolves the skill in every
// task that asks it), and the skills manager (add more through the LLM, edit by hand, delete, add a new skill).
import { afterEach, describe, expect, it } from "vitest";
import type { TapReply } from "@sgz/shared";
import { createSkillsHub } from "../../src/skills/hub.js";
import { chatHarness, inMsg } from "./harness.js";

const DM = "555";
let h: ReturnType<typeof chatHarness>;
afterEach(() => {
  h?.store.close();
  h = undefined as never;
});

function setup() {
  h = chatHarness();
  h.store.upsertUser({ ...h.user, tgChatId: DM });
  const hub = createSkillsHub({ store: h.store, llm: h.llm, notifier: h.notifier, chats: h.env, now: h.now });
  return hub;
}
async function ask(topics: string[]) {
  h.page.messages = [inMsg("1", `Есть опыт с ${topics.join(", ")}?`)];
  h.llm.onTriageChat = () => ({ kind: "question", topics });
  await h.sync();
}
const tagOf = (name: string) => h.store.listKbTags(h.user.id).find((t) => t.name === name)!;
const labels = (c: { buttons: { text: string }[][] }) => c.buttons.map((r) => r.map((b) => b.text));
const reply = (r: TapReply | string) => r as TapReply;

describe("pending skills in one list", () => {
  it("lists the waiting skills; ❌ answers the skill in the task and the list empties", async () => {
    const hub = setup();
    h.story("Jest", { title: "Тесты биллинга" });
    await ask(["Jest", "Vitest"]);
    const card = hub.pendingCard(h.user);
    expect(card.text).toContain("2 навыка ждут ответа");
    expect(labels(card)).toEqual([["✍️ Jest", "✅ Jest", "❌ Jest"], ["✍️ Vitest", "❌ Vitest"]]); // ✅ only with a story to cite
    const r = reply(await hub.tap(`ks:n:${tagOf("Vitest").id}`, DM));
    expect(tagOf("Vitest").status).toBe("no");
    expect(r.text).toContain("1 навык ждёт ответа");
    reply(await hub.tap(`ks:y:${tagOf("Jest").id}`, DM));
    expect(tagOf("Jest").status).toBe("yes");
    expect(h.store.listKbStories(h.user.id, tagOf("Jest").id)[0]!.confirmed).toBe(true);
    expect(hub.pendingCard(h.user).text).toContain("Вопросов по навыкам нет");
    expect(h.tasks().at(-1)!.state).not.toBe("awaiting_review"); // all topics answered: the reply is drafted
  });

  it("✍️ makes the skill's review wait for the next text in the personal chat", async () => {
    const hub = setup();
    await ask(["Vitest"]);
    const r = reply(await hub.tap(`ks:w:${tagOf("Vitest").id}`, DM));
    expect(r.say).toContain("Vitest");
    expect(h.store.awaitingKbReviews(DM)).toHaveLength(1);
  });

  it("only the user's own chat may tap", async () => {
    const hub = setup();
    expect(await hub.tap("ks:n:1", "999")).toBe("кнопка устарела");
  });
});

describe("skills manager", () => {
  it("lists confirmed skills with story counts and shows what is written", async () => {
    const hub = setup();
    h.story("Go", { title: "Сервис платежей", did: "Написал сервис на Go." });
    h.store.setKbTagStatus(tagOf("Go").id, "yes");
    const list = hub.listCard(h.user);
    expect(list.text).toContain("Твои навыки");
    expect(labels(list).flat()).toContain("Go · 1");
    const d = reply(await hub.tap(`ks:o:${tagOf("Go").id}`, DM));
    expect(d.text).toContain("Сервис платежей");
    expect(d.text).toContain("Написал сервис на Go.");
    expect(labels(d).flat()).toEqual(expect.arrayContaining(["➕ Дополнить", "✏️ Править", "🗑 Убрать навык"]));
  });

  it("➕ Дополнить: the text goes through the LLM into a story, the skill stays confirmed", async () => {
    const hub = setup();
    h.store.upsertKbTag(h.user.id, { name: "Go", status: "yes" });
    h.llm.onJson = () => ({ stories: [{ title: "Нагрузочные тесты", company: "", period: "", context: "", did: "Гонял k6 по API.", result: "", tags: ["Go"] }] });
    await hub.tap(`ks:m:${tagOf("Go").id}`, DM);
    expect(await hub.text(DM, "Гонял k6 по нашему API")).toContain("Нагрузочные тесты");
    expect(h.store.listKbStories(h.user.id, tagOf("Go").id).map((s) => s.title)).toEqual(["Нагрузочные тесты"]);
    expect(await hub.text(DM, "ещё что-то")).toBeNull(); // the wait is over
  });

  it("one skill = one entry: an addition is reconciled with what is written, several old entries merge into one", async () => {
    const hub = setup();
    h.story("FastAPI", { title: "Backend era2.ai", did: "Платежи и админка на FastAPI." });
    h.story("FastAPI", { title: "Backend-driven UI", did: "198 моделей через FastAPI." });
    h.store.setKbTagStatus(tagOf("FastAPI").id, "yes");
    const two = reply(await hub.tap(`ks:o:${tagOf("FastAPI").id}`, DM));
    expect(labels(two).flat()).toContain("🧩 Свести в одну запись");
    const prompts: string[] = [];
    h.llm.onJson = (_t, _tier, prompt) => (prompts.push(prompt), { stories: [{ title: "FastAPI в era2.ai", company: "era2.ai", period: "", context: "", did: "Платежи, админка и 198 моделей через backend-driven UI на FastAPI.", result: "", tags: ["FastAPI"] }] });
    const one = reply(await hub.tap(`ks:r:${tagOf("FastAPI").id}`, DM));
    expect(prompts[0]).toContain("Платежи и админка на FastAPI."); // the model reads everything already written
    expect(prompts[0]).toContain("198 моделей через FastAPI.");
    expect(h.store.listKbStories(h.user.id, tagOf("FastAPI").id)).toHaveLength(1);
    expect(labels(one).flat()).not.toContain("🧩 Свести в одну запись");

    await hub.tap(`ks:m:${tagOf("FastAPI").id}`, DM);
    await hub.text(DM, "Ещё сделал рекуррентные платежи");
    expect(prompts[1]).toContain("Платежи, админка и 198 моделей"); // the merged entry + the new text go in together
    expect(prompts[1]).toContain("рекуррентные платежи");
    expect(h.store.listKbStories(h.user.id, tagOf("FastAPI").id)).toHaveLength(1);
  });

  it("✏️ edit replaces «что делал» by hand and confirms the story; «отмена» keeps it", async () => {
    const hub = setup();
    const s = h.story("Go", { did: "Старый текст." });
    await hub.tap(`ks:e:${s.id}`, DM);
    expect(await hub.text(DM, "отмена")).toContain("как было");
    expect(h.store.getKbStory(s.id)!.did).toBe("Старый текст.");
    await hub.tap(`ks:e:${s.id}`, DM);
    await hub.text(DM, "Новый текст.");
    expect(h.store.getKbStory(s.id)).toMatchObject({ did: "Новый текст.", confirmed: true });
  });

  it("new skill: name, then «-» adds it without a story; 🗑 removes skill, stories and the claim", async () => {
    const hub = setup();
    await hub.tap("ks:new", DM);
    expect(await hub.text(DM, "Rust")).toContain("Rust");
    expect(await hub.text(DM, "-")).toContain("без описания");
    expect(tagOf("Rust").status).toBe("yes");
    expect(h.store.getProfile(h.user.id)!.verified_skills).toContain("Rust");

    h.story("Rust", { title: "CLI на Rust" });
    expect(reply(await hub.tap(`ks:d:${tagOf("Rust").id}`, DM)).text).toContain("Убрать");
    await hub.tap(`ks:D:${tagOf("Rust").id}`, DM);
    expect(tagOf("Rust").status).toBe("unknown");
    expect(h.store.listKbStories(h.user.id, tagOf("Rust").id)).toHaveLength(0);
    expect(h.store.getProfile(h.user.id)!.verified_skills).not.toContain("Rust");
  });
});
