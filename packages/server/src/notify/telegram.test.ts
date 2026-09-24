import { describe, expect, it, vi } from "vitest";
import { createTelegram, startTelegramCallbacks } from "./telegram.js";

describe("telegram commands", () => {
  it("answers slash commands only from the configured chats", async () => {
    const sent: { chat_id: number; text: string }[] = [];
    let polls = 0;
    const fakeFetch = (async (url: string, init: { body: string }) => {
      const method = url.split("/").at(-1);
      const body = JSON.parse(init.body) as { chat_id: number; text: string; allowed_updates?: string[] };
      if (method === "getUpdates") {
        if (polls++) return new Promise(() => undefined); // park the loop after the first batch
        expect(body.allowed_updates).toContain("message");
        const result = [
          { update_id: 1, message: { chat: { id: 666 }, message_id: 1, text: "/status" } },
          { update_id: 2, message: { chat: { id: 42 }, message_id: 2, text: "привет" } },
          { update_id: 3, message: { chat: { id: 42 }, message_id: 3, text: "/Status@sgz_bot now" } },
        ];
        return new Response(JSON.stringify({ ok: true, result }));
      }
      if (method === "sendMessage") sent.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    const stop = startTelegramCallbacks("t", async () => "", {
      fetch: fakeFetch,
      commands: { chatIds: ["42"], onCommand: async (cmd) => (seen.push(cmd), "итоги") },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    stop();
    expect(seen).toEqual(["/status"]);
    expect(sent[0]).toMatchObject({ chat_id: 42, text: "итоги" });
  });

  it("passes command args and hands plain text to onText, allowed chats only", async () => {
    const sent: { chat_id: number; text: string }[] = [];
    let polls = 0;
    const fakeFetch = (async (url: string, init: { body: string }) => {
      const method = url.split("/").at(-1);
      const body = JSON.parse(init.body) as { chat_id: number; text: string };
      if (method === "getUpdates") {
        if (polls++) return new Promise(() => undefined);
        const result = [
          { update_id: 1, message: { chat: { id: 666 }, message_id: 1, text: "чужой" } },
          { update_id: 2, message: { chat: { id: 42 }, message_id: 2, text: "/mock Рога и Копыта" } },
          { update_id: 3, message: { chat: { id: 42 }, message_id: 3, text: "мой ответ" } },
        ];
        return new Response(JSON.stringify({ ok: true, result }));
      }
      if (method === "sendMessage") sent.push(body);
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    const texts: string[] = [];
    const stop = startTelegramCallbacks("t", async () => "", {
      fetch: fakeFetch,
      commands: {
        chatIds: ["42"],
        onCommand: async (cmd, args, chatId) => `${cmd}|${args}|${chatId}`,
        onText: async (chatId, text) => (texts.push(`${chatId}:${text}`), "разбор"),
      },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    stop();
    expect(texts).toEqual(["42:мой ответ"]);
    expect(sent.map((s) => s.text)).toEqual(["/mock|Рога и Копыта|42", "разбор"]);
  });
});

describe("telegram offset", () => {
  it("a free text replayed after a restart is handled once: the offset survives in the store", async () => {
    // Telegram drops an update only when a later getUpdates passes a higher offset; a SIGTERM before that poll
    // leaves it pending, and a restart asking with offset 0 gets it again.
    const pending = [{ update_id: 5, message: { chat: { id: 42 }, message_id: 1, text: "история про Jest" } }];
    const offsets: number[] = [];
    let served = 0;
    const fakeFetch = (async (url: string, init: { body: string }) => {
      if (url.split("/").at(-1) !== "getUpdates") return new Response(JSON.stringify({ ok: true, result: true }));
      const { offset } = JSON.parse(init.body) as { offset: number };
      offsets.push(offset);
      if (served++ % 2) return new Promise(() => undefined); // the process "dies" during its second poll
      return new Response(JSON.stringify({ ok: true, result: pending.filter((u) => u.update_id >= offset) }));
    }) as unknown as typeof fetch;
    const settings = new Map<string, string>();
    const store = { getSetting: (k: string) => settings.get(k) ?? null, setSetting: (k: string, v: string) => void settings.set(k, v) };
    const texts: string[] = [];
    const boot = () => startTelegramCallbacks("t", async () => "", { fetch: fakeFetch, store, commands: { chatIds: ["42"], onCommand: async () => "", onText: async (_c, t) => (texts.push(t), null) } });
    const first = boot();
    await vi.waitFor(() => expect(offsets).toHaveLength(2));
    first();
    const second = boot();
    await vi.waitFor(() => expect(offsets).toHaveLength(4));
    second();
    expect(offsets).toEqual([0, 6, 6, 6]);
    expect(settings.get("tg_offset")).toBe("6");
    expect(texts).toEqual(["история про Jest"]);
  });
});

describe("telegram cards", () => {
  it("a TapReply replaces the tapped message's text and buttons", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let polls = 0;
    const fakeFetch = (async (url: string, init: { body: string }) => {
      const method = url.split("/").at(-1)!;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (method === "getUpdates") {
        if (polls++) return new Promise(() => undefined);
        return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, callback_query: { id: "q", data: "kr:1:c", message: { chat: { id: 42 }, message_id: 9, text: "card" } } }] }));
      }
      calls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    const stop = startTelegramCallbacks("t", async () => ({ note: "✅ Jest", text: "<b>Acme</b> …", buttons: [[{ text: "✅ Vitest", data: "kr:2:c" }]] }), { fetch: fakeFetch });
    await vi.waitFor(() => expect(calls.some((c) => c.method === "editMessageText")).toBe(true));
    stop();
    const edit = calls.find((c) => c.method === "editMessageText")!.body;
    expect(edit).toMatchObject({ chat_id: 42, message_id: 9, text: "<b>Acme</b> …", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Vitest", callback_data: "kr:2:c" }]] } });
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.body.text).toBe("✅ Jest");
  });

  it("onTap gets the tapped chat; a TapReply's `say` follows the edit as a new message there", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let polls = 0;
    const fakeFetch = (async (url: string, init: { body: string }) => {
      const method = url.split("/").at(-1)!;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (method === "getUpdates") {
        if (polls++) return new Promise(() => undefined);
        return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, callback_query: { id: "q", data: "kr:1:e", message: { chat: { id: 42 }, message_id: 9, text: "card" } } }] }));
      }
      calls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    const chats: string[] = [];
    const stop = startTelegramCallbacks("t", async (_d, chatId) => (chats.push(chatId), { note: "Жду", text: "card", buttons: [], say: "Напиши про <b>Jest</b>" }), { fetch: fakeFetch });
    await vi.waitFor(() => expect(calls.some((c) => c.method === "sendMessage")).toBe(true));
    stop();
    expect(chats).toEqual(["42"]);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "editMessageText", "sendMessage"]);
    expect(calls[2]!.body).toMatchObject({ chat_id: 42, text: "Напиши про <b>Jest</b>", parse_mode: "HTML" });
  });

  it("edit replaces a sent message's text and buttons", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: { body: string }) => (sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> }), new Response(JSON.stringify({ ok: true, result: true })))) as unknown as typeof fetch;
    const tg = createTelegram("t", "42", "", { fetch: fakeFetch });
    await tg.edit!(7, "<b>x</b>", [[{ text: "a", data: "1" }]]);
    expect(sent[0]!.url).toMatch(/\/editMessageText$/);
    expect(sent[0]!.body).toMatchObject({ chat_id: "42", message_id: 7, text: "<b>x</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "a", callback_data: "1" }]] } });
  });

  it("forUser binds ask / edit / alert to the seeker's chat, the owner's chat when she has none", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: { body: string }) => (sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> }), new Response(JSON.stringify({ ok: true, result: { message_id: 3 } })))) as unknown as typeof fetch;
    const tg = createTelegram("t", "42", "", { fetch: fakeFetch });
    const her = tg.forUser!({ tgChatId: "555" });
    expect(await her.ask!("card", [])).toBe(3);
    await her.edit!(3, "card v2", []);
    await her.alert("t", "b");
    await tg.forUser!({ tgChatId: "" }).alert("t", "b");
    await tg.alert("ops", "b");
    expect(sent.map((s) => `${s.url.split("/").at(-1)}:${String(s.body.chat_id)}`)).toEqual(["sendMessage:555", "editMessageText:555", "sendMessage:555", "sendMessage:42", "sendMessage:42"]);
  });

  it("edit is retried like a send, a final failure is only logged", async () => {
    let n = 0;
    const fakeFetch = (async () => (n++ ? new Response(JSON.stringify({ ok: true, result: true })) : new Response("{}", { status: 502 }))) as unknown as typeof fetch;
    const warns: string[] = [];
    await createTelegram("t", "42", "", { fetch: fakeFetch, warn: (m) => warns.push(m) }).edit!(7, "x", []);
    expect(n).toBe(2);
    const bad = (async () => new Response(JSON.stringify({ description: "Bad Request: message to edit not found" }), { status: 400 })) as unknown as typeof fetch;
    await createTelegram("t", "42", "", { fetch: bad, warn: (m) => warns.push(m) }).edit!(7, "x", []);
    expect(warns).toEqual(["telegram: editMessageText: telegram: 400 Bad Request: message to edit not found"]);
  });

  it("ask sends one row per list (a flat list is one row) and returns the message id", async () => {
    const sent: Record<string, unknown>[] = [];
    const fakeFetch = (async (_u: string, init: { body: string }) => (sent.push(JSON.parse(init.body) as Record<string, unknown>), new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })))) as unknown as typeof fetch;
    const tg = createTelegram("t", "42", "", { fetch: fakeFetch });
    expect(await tg.ask!("x", [[{ text: "a", data: "1" }], [{ text: "b", data: "2" }]])).toBe(5);
    expect(sent[0]!.reply_markup).toEqual({ inline_keyboard: [[{ text: "a", callback_data: "1" }], [{ text: "b", callback_data: "2" }]] });
    await tg.ask!("y", [{ text: "a", data: "1" }, { text: "b", data: "2" }]);
    expect(sent[1]!.reply_markup).toEqual({ inline_keyboard: [[{ text: "a", callback_data: "1" }, { text: "b", callback_data: "2" }]] });
  });
});
