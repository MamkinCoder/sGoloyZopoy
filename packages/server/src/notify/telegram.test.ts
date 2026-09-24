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

describe("telegram cards", () => {
  it("a TapReply replaces the tapped message's text and buttons", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let polls = 0;
    const fakeFetch = (async (url: string, init: { body: string }) => {
      const method = url.split("/").at(-1)!;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (method === "getUpdates") {
        if (polls++) return new Promise(() => undefined);
        return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, callback_query: { id: "q", data: "ct:1:0:y", message: { chat: { id: 42 }, message_id: 9, text: "card" } } }] }));
      }
      calls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    const stop = startTelegramCallbacks("t", async () => ({ note: "✅ Jest", text: "<b>Acme</b> …", buttons: [[{ text: "✅ Vitest", data: "ct:1:1:y" }]] }), { fetch: fakeFetch });
    await vi.waitFor(() => expect(calls.some((c) => c.method === "editMessageText")).toBe(true));
    stop();
    const edit = calls.find((c) => c.method === "editMessageText")!.body;
    expect(edit).toMatchObject({ chat_id: 42, message_id: 9, text: "<b>Acme</b> …", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Vitest", callback_data: "ct:1:1:y" }]] } });
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.body.text).toBe("✅ Jest");
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
