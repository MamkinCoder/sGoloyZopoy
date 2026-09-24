// The knowledge-base review gate in chats: one card per task (stories, escaping, length), «Подтвердить» /
// «Дополнить» / «Нет навыка», the free-text story -> kb.ingest -> expanded, modes, the draft's KB block, fallback.
import { afterEach, describe, expect, it } from "vitest";
import { askStoryText, kbText, parseKbCallback } from "../../src/agent/chats/review.js";
import { FALLBACK_AFTER_MS } from "../../src/agent/chats/tasks.js";
import { chatHarness, inMsg, TG_CHAT } from "./harness.js";

let h: ReturnType<typeof chatHarness>;
afterEach(() => {
  h?.store.close();
  h = undefined as never;
});

const reviews = () => h.store.listKbReviews(h.tasks().at(-1)!.id);
const tag = (name: string) => h.store.listKbTags(h.user.id).find((t) => t.name === name)!;
const draftKb = () => (h.llm.calls.filter((c) => c.method === "answerChat").at(-1)!.args[4] as { text: string } | undefined)?.text ?? "";

/** One employer question about `topics`, synced up to the card. */
async function ask(topics: string[], text = `Есть опыт с ${topics.join(", ")}?`) {
  h.page.messages = [inMsg("1", text)];
  h.llm.onTriageChat = () => ({ kind: "question", topics });
  h.llm.onAnswerChat = () => ({ reply: "Ответ.", needs_human: false, reason: "" });
  await h.sync();
}

describe("KB review card", () => {
  it("lists every topic with up to 3 stories, escapes HTML and shows «Подтвердить» only when there are stories to cite", async () => {
    h = chatHarness();
    for (let i = 1; i <= 4; i++) h.story("Jest", { title: `Тесты <${i}>`, did: `Писал тесты & моки ${i}.`, result: "Меньше багов" });
    await ask(["Jest", "Go", "Vitest"], "Писали <script>тесты</script>?");
    expect(h.asks).toHaveLength(1);
    const { text } = h.asks[0]!;
    expect(text).toContain("<b>Acme</b> спрашивает:\n«Писали &lt;script&gt;тесты&lt;/script&gt;?»");
    expect(text).toContain("<b>Jest</b>: историй 4 (показаны 3)");
    expect(text).toContain("  • Тесты &lt;4&gt; (Яндекс): Писал тесты &amp; моки 4.; итог: Меньше багов");
    expect(text).not.toContain("Тесты &lt;1&gt;"); // the oldest one is cut
    expect(text).toContain("<b>Go</b>: историй нет, навык отмечен"); // Go: verified_skills -> tag yes
    expect(text).toContain("<b>Vitest</b>: историй нет");
    expect(h.labels()).toEqual([
      ["Подтвердить Jest", "Дополнить Jest", "Нет навыка Jest"],
      ["Дополнить Go", "Нет навыка Go"], // a yes tag without stories: nothing to cite, so ask for one
      ["Дополнить Vitest", "Нет навыка Vitest"],
    ]);
    // One pending review per topic, the unknown topic became a tag, all carry the card's message id.
    expect(reviews().map((r) => [r.topic, r.state, r.tgMessageId])).toEqual([
      ["Jest", "pending", "1001"],
      ["Go", "pending", "1001"],
      ["Vitest", "pending", "1001"],
    ]);
    expect(tag("Vitest").status).toBe("unknown");
    expect(reviews()[0]!.prompt).toBe("Писали <script>тесты</script>?");
  });

  it("stays under Telegram's 4096 chars with many long stories", async () => {
    h = chatHarness();
    const topics = ["Jest", "Vitest", "Cypress", "Playwright", "Mocha", "Karma"];
    for (const t of topics) for (let i = 0; i < 3; i++) h.story(t, { title: `${t} ${"история ".repeat(12)}${i}`, did: "Очень длинное описание & <деталей>. ".repeat(10), result: "Итог ".repeat(30) });
    await ask(topics, "Вопрос ".repeat(200));
    const { text, buttons } = h.asks[0]!;
    expect(text.length).toBeLessThanOrEqual(4096);
    for (const t of topics) expect(text).toContain(`<b>${t}</b>`);
    expect(buttons).toHaveLength(6);
    for (const b of buttons.flat()) expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);
  });

  it("«Подтвердить»: tag yes, the shown stories confirmed, review confirmed, the reply is drafted from the story", async () => {
    h = chatHarness();
    const st = h.story("Jest", { title: "Тесты биллинга", did: "Покрыл биллинг тестами на Jest." });
    await ask(["Jest"]);
    const r = h.tap("Подтвердить Jest") as { note: string; text: string; buttons: unknown[] };
    expect(r.note).toBe("✅ Jest");
    expect(r.text).toContain("<b>Jest</b>: ✅ подтверждено");
    expect(r.buttons).toHaveLength(0);
    expect(reviews()[0]!.state).toBe("confirmed");
    expect(tag("Jest").status).toBe("yes");
    expect(h.store.getKbStory(st.id)!.confirmed).toBe(true);
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("sent");
    expect(draftKb()).toContain("- Jest: есть опыт (историй: 1)");
    expect(draftKb()).toContain("### Тесты биллинга [Jest]");
    expect(draftKb()).toContain("Что сделал: Покрыл биллинг тестами на Jest.");
  });

  it("«Нет навыка»: tag no, never_claim in the profile, review denied, the draft is told not to claim it", async () => {
    h = chatHarness();
    await ask(["Vitest"]);
    const r = h.tap("Нет навыка Vitest") as { note: string; text: string };
    expect(r.note).toBe("❌ Vitest: нет навыка");
    expect(r.text).toContain("<b>Vitest</b>: ❌ нет навыка");
    expect(reviews()[0]!.state).toBe("denied");
    expect(tag("Vitest").status).toBe("no");
    expect(h.store.getProfile(h.user.id)!.never_claim_skills).toContain("Vitest");
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("sent");
    expect(draftKb()).toContain("- Vitest: нет в опыте, не заявлять");
    const profile = h.llm.calls.find((c) => c.method === "answerChat")!.args[0] as { never_claim_skills: string[] };
    expect(profile.never_claim_skills).toContain("Vitest");
  });

  it("«Дополнить» -> the question -> the next text -> kb.ingest -> story saved, review expanded, card edited, reply sent", async () => {
    h = chatHarness();
    await ask(["Vitest", "Jest"]);
    const r = h.tap("Дополнить Vitest") as { note: string; text: string; say?: string };
    expect(r.say).toBe(askStoryText("Vitest"));
    expect(r.say).toBe("Напиши, что ты делал с Vitest: где, что именно, какой результат.");
    expect(r.text).toContain("<b>Vitest</b>: ✍️ жду твой рассказ");
    expect(reviews()[0]).toMatchObject({ state: "pending", awaitingChat: TG_CHAT });

    expect(kbText(h.env, "777", "не тот чат")).toBeNull(); // other chats go to other handlers
    h.llm.onJson = () => ({ stories: [{ title: "Компонентные тесты", company: "Яндекс", period: "2022-2024", context: "", did: "Перевёл компонентные тесты на Vitest, покрытие 60%.", result: "", tags: [] }] });
    expect(kbText(h.env, TG_CHAT, "В Яндексе переводил компонентные тесты на Vitest, покрытие 60%")).toBe("Принял, записываю историю про Vitest.");
    expect(reviews()[0]!.awaitingChat).toBe(""); // the next text is not this review's
    expect(kbText(h.env, TG_CHAT, "ещё текст")).toBeNull();
    await h.drain();

    const stories = h.store.listKbStories(h.user.id, tag("Vitest").id);
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ source: "telegram", confirmed: true, did: "Перевёл компонентные тесты на Vitest, покрытие 60%." });
    expect(tag("Vitest").status).toBe("yes");
    expect(reviews()[0]!.state).toBe("expanded");
    expect(h.tasks()[0]).toMatchObject({ state: "awaiting_review", topics: [{ name: "Vitest", answer: "yes", by: "human" }, { name: "Jest", answer: null }] });
    const [id, text] = h.notifier.edit.mock.calls.at(-1)!;
    expect(id).toBe(1001);
    expect(text).toContain("<b>Vitest</b>: ✍️ дополнено, история сохранена");

    h.tap("Нет навыка Jest");
    await h.drain();
    expect(h.tasks()[0]!.state).toBe("sent");
    expect(draftKb()).toContain("Перевёл компонентные тесты на Vitest");
  });

  it("several «Дополнить»: asked one at a time, each text goes to its own topic", async () => {
    h = chatHarness();
    await ask(["Jest", "Vitest"]);
    expect(h.tap("Дополнить Jest")).toMatchObject({ say: askStoryText("Jest") });
    const second = h.tap("Дополнить Vitest") as { note: string; say?: string };
    expect(second.say).toBeUndefined();
    expect(second.note).toBe("Спрошу про Vitest после ответа про Jest");

    h.llm.onJson = (_t, _tier, prompt) => ({ stories: [{ title: "История", company: "", period: "", context: "", did: prompt.includes("про Jest текст") ? "Тесты на Jest." : "Тесты на Vitest.", result: "", tags: [] }] });
    expect(kbText(h.env, TG_CHAT, "про Jest текст")).toBe(`Принял, записываю историю про Jest.\n\n${askStoryText("Vitest")}`);
    expect(kbText(h.env, TG_CHAT, "про Vitest текст")).toBe("Принял, записываю историю про Vitest.");
    await h.drain();
    expect(h.store.listKbStories(h.user.id, tag("Jest").id).map((s) => s.did)).toEqual(["Тесты на Jest."]);
    expect(h.store.listKbStories(h.user.id, tag("Vitest").id).map((s) => s.did)).toEqual(["Тесты на Vitest."]);
    expect(reviews().map((r) => r.state)).toEqual(["expanded", "expanded"]);
    expect(h.tasks()[0]!.state).toBe("sent");
  });

  it("the employer writing again while a story is awaited: the story answers the fresh task", async () => {
    h = chatHarness();
    await ask(["Vitest"]);
    h.tap("Дополнить Vitest");
    h.page.messages.push(inMsg("2", "Ответьте, пожалуйста"));
    h.page.lastModified = "2026-09-25T11:00:00.000Z";
    await h.sync();
    const [old, fresh] = h.tasks();
    expect([old!.state, fresh!.state]).toEqual(["superseded", "awaiting_review"]);
    h.llm.onJson = () => ({ stories: [{ title: "Тесты", company: "", period: "", context: "", did: "Писал тесты на Vitest.", result: "", tags: [] }] });
    expect(kbText(h.env, TG_CHAT, "Писал тесты на Vitest")).toBe("Принял, записываю историю про Vitest.");
    await h.drain();
    expect(h.store.listKbReviews(old!.id)[0]!.state).toBe("expanded");
    expect(h.store.listKbReviews(fresh!.id)[0]!.state).toBe("expanded");
    expect(h.tasks().at(-1)!.state).toBe("sent");
  });

  it("a text the ingest cannot use: asks again, the review stays open", async () => {
    h = chatHarness();
    await ask(["Vitest"]);
    h.tap("Дополнить Vitest");
    h.llm.onJson = () => ({ stories: [] });
    kbText(h.env, TG_CHAT, "ну было");
    await h.drain();
    expect(h.asks.at(-1)!.text).toContain("Не получилось собрать историю про <b>Vitest</b>");
    expect(reviews()[0]).toMatchObject({ state: "pending", awaitingChat: "" });
    expect(h.tasks()[0]!.state).toBe("awaiting_review");
    expect(h.store.listKbStories(h.user.id)).toHaveLength(0);
  });

  it("new_only: topics with confirmed stories and denied tags are not shown; unconfirmed seed stories are asked", async () => {
    h = chatHarness();
    h.store.setSetting("kb_review_mode", "new_only");
    const jest = h.story("Jest");
    h.store.saveKbStory({ ...jest, confirmed: true, tagIds: jest.tags.map((t) => t.id) });
    h.story("Docker"); // seed only, tag unknown: not proof of experience
    await ask(["Jest", "Kafka", "Vitest", "Docker"]);
    expect(h.tasks()[0]!.topics).toEqual([
      { name: "Jest", answer: "yes", by: "profile" },
      { name: "Kafka", answer: "no", by: "profile" }, // never_claim_skills -> tag no
      { name: "Vitest", answer: null, by: null },
      { name: "Docker", answer: null, by: null },
    ]);
    expect(h.labels()[0]).toEqual(["Дополнить Vitest", "Нет навыка Vitest"]);
    expect(h.asks[0]!.text).toContain("<b>Jest</b>: ✅ есть в базе");
    expect(h.asks[0]!.text).toContain("<b>Kafka</b>: ❌ нет в базе, не заявляю");
    expect(reviews().map((r) => r.topic)).toEqual(["Vitest", "Docker"]);
  });

  it("an alias resolves to the existing tag", async () => {
    h = chatHarness();
    h.store.upsertKbTag(h.user.id, { name: "React", aliases: ["react.js"], status: "yes" });
    h.story("React");
    await ask(["react.js"]);
    expect(reviews()[0]!.tagId).toBe(tag("React").id);
    expect(h.asks[0]!.text).toContain("<b>react.js</b>: историй 1");
    h.tap("Нет навыка react.js");
    expect(tag("React").status).toBe("no");
    expect(h.store.listKbTags(h.user.id).filter((t) => /react/i.test(t.name))).toHaveLength(1);
  });

  it("12 h fallback: open reviews expire (a late «Дополнить» text is not captured), the topic is not claimed", async () => {
    h = chatHarness();
    await ask(["Rust"]);
    h.tap("Дополнить Rust");
    h.advance(FALLBACK_AFTER_MS);
    await h.drain();
    expect(reviews()[0]!.state).toBe("expired");
    expect(h.tasks()[0]).toMatchObject({ state: "sent", topics: [{ name: "Rust", answer: "no", by: "fallback" }] });
    expect(draftKb()).toContain("- Rust: нет в опыте, не заявлять");
    expect(kbText(h.env, TG_CHAT, "поздний ответ")).toBeNull();
    expect(tag("Rust").status).toBe("unknown"); // not the human's answer
    // A tap on the old card changes nothing.
    expect(h.tap("Нет навыка Rust", h.asks[0])).toMatchObject({ note: "уже учтено" });
  });

  it("the draft goes through kbBrief like letters: a fallback «нет» topic leaves the stories and joins the reply guard", async () => {
    h = chatHarness();
    h.story("Go", { title: "Платёжный шлюз", did: "Писал шлюз на Go. Переписал воркер на Rust ради скорости." });
    h.story("Go", { title: "Rust-прототип", did: "Собрал прототип." });
    await ask(["Rust"], "Есть опыт с Rust? У нас Go.");
    h.advance(FALLBACK_AFTER_MS);
    await h.drain();
    const call = h.llm.calls.filter((c) => c.method === "answerChat").at(-1)!;
    const kb = call.args[4] as { text: string; no: string[] };
    expect(kb.text).toContain("- Rust: нет в опыте, не заявлять");
    expect(kb.text).toContain("Писал шлюз на Go.");
    expect(kb.text).not.toContain("воркер на Rust"); // the sentence naming it is gone
    expect(kb.text).not.toContain("Rust-прототип"); // a title naming it drops the story
    expect(kb.no).toContain("Rust");
    expect((call.args[0] as { never_claim_skills: string[] }).never_claim_skills).toContain("Rust");
  });

  it("a denied tag's aliases and story sentences never reach the draft; its aliases reach the reply guard", async () => {
    h = chatHarness();
    h.store.upsertKbTag(h.user.id, { name: "PostgreSQL", aliases: ["postgres"] });
    h.story("PostgreSQL", { title: "Отчёты", did: "Поднял postgres-реплику для отчётов. Настроил выгрузку в CSV." });
    await ask(["PostgreSQL"]);
    h.tap("Нет навыка PostgreSQL");
    await h.drain();
    expect(draftKb()).toContain("- PostgreSQL: нет в опыте, не заявлять");
    expect(draftKb()).not.toContain("postgres-реплику");
    const profile = h.llm.calls.filter((c) => c.method === "answerChat").at(-1)!.args[0] as { never_claim_skills: string[] };
    expect(profile.never_claim_skills).toEqual(expect.arrayContaining(["PostgreSQL", "postgres"]));
  });

  it("parses kr: callbacks", () => {
    expect(parseKbCallback("kr:12:e")).toEqual({ reviewId: 12, action: "e" });
    expect(parseKbCallback("kr:12:x")).toBeNull();
  });
});
