import { describe, expect, it, vi } from "vitest";
import { startTelegramCallbacks } from "./telegram.js";

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
});
