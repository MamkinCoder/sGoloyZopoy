import { describe, expect, it } from "vitest";
import { flattenMessages, stagehandAdapter, stagehandTier } from "../../src/llm/stagehand.js";
import { createLLM } from "../../src/llm/index.js";
import { cfg, stubDir, stubEnv } from "./fixtures.js";

describe("stagehand adapter", () => {
  it("flattens system + messages with role markers and appends the schema", () => {
    const p = flattenMessages({
      systemPrompt: "You are a browser agent.",
      messages: [
        { role: "user", content: "Find the apply button" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "now" },
      ],
      responseFormat: { type: "json_schema", schema: { type: "object", properties: { idx: { type: "number" } } } },
    });
    expect(p).toContain("### SYSTEM\nYou are a browser agent.");
    expect(p).toContain("### USER\nFind the apply button");
    expect(p).toContain("### ASSISTANT\nok");
    expect(p).toContain("Return only JSON matching this schema");
    expect(p).toContain('"idx"');
    expect(p.indexOf("### SYSTEM")).toBeLessThan(p.indexOf("### USER"));
  });

  it("maps json_schema responses to structured, text otherwise", async () => {
    const seen: { tier: string; prompt: string; schema?: unknown }[] = [];
    const llm = stagehandAdapter(async (req) => {
      seen.push(req);
      return req.schema ? { text: 'prose {"idx": 3} end' } : { text: "hello" };
    }, "fast");
    const j = await llm.generate({ messages: [{ role: "user", content: "x" }], responseFormat: { type: "json_schema", schema: { type: "object" } } });
    expect(j.structured).toEqual({ idx: 3 });
    expect(seen[0]?.schema).toEqual({ type: "object" });
    const t = await llm.generate({ messages: [{ role: "user", content: "y" }], responseFormat: { type: "text" }, temperature: 0 });
    expect(t).toEqual({ text: "hello" });
    expect(seen[1]?.schema).toBeUndefined();
  });

  it("prefers structured_output from the envelope and tolerates unparsable text", async () => {
    const a = stagehandAdapter(async () => ({ text: "", structured: { ok: true } }));
    expect(await a.generate({ messages: [], responseFormat: { type: "json_schema", schema: {} } })).toEqual({ text: '{"ok":true}', structured: { ok: true } });
    const b = stagehandAdapter(async () => ({ text: "nope" }));
    expect(await b.generate({ messages: [], responseFormat: { type: "json_schema", schema: {} } })).toEqual({ text: "nope", structured: undefined });
  });

  it("reads the tier override from env", () => {
    expect(stagehandTier({})).toBe("fast");
    expect(stagehandTier({ SGZ_STAGEHAND_TIER: "write" })).toBe("write");
    expect(stagehandTier({ SGZ_STAGEHAND_TIER: "bogus" })).toBe("fast");
  });

  it("goes through the real client and the claude stub", async () => {
    const dir = stubDir();
    const llm = createLLM(cfg, null, { env: stubEnv(dir, "valid", { selector: "#apply" }) });
    const r = await llm.stagehand().generate({ messages: [{ role: "user", content: "find" }], responseFormat: { type: "json_schema", schema: { type: "object" } } });
    expect(r.structured).toEqual({ selector: "#apply" });
  });
});
