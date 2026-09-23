import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeError, buildArgs, detectFeatures, extractJson, parseEnvelope, resetFeatureCache, runClaude } from "../../src/llm/claude.js";
import { createMutex } from "../../src/llm/mutex.js";
import { REPO_DIR, STUB_BIN, stubDir, stubEnv } from "./fixtures.js";

describe("extractJson", () => {
  it("parses whole text", () => {
    expect(extractJson(' {"a":1} ')).toEqual({ a: 1 });
    expect(extractJson("[1,2]")).toEqual([1, 2]);
  });
  it("parses fenced block", () => {
    expect(extractJson('Вот:\n```json\n{"a": "b"}\n```\nГотово')).toEqual({ a: "b" });
    expect(extractJson("```\n[1]\n```")).toEqual([1]);
  });
  it("parses after leading prose and skips unbalanced junk", () => {
    expect(extractJson('Sure { not json } here is it: {"x":{"y":[1,"}"]}} trailing')).toEqual({ x: { y: [1, "}"] } });
    expect(extractJson('text [ oops ] then ["a", "b\\"]"] end')).toEqual(["a", 'b"]']);
  });
  it("throws when nothing parses", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
    expect(() => extractJson("{broken")).toThrow();
  });
});

describe("parseEnvelope", () => {
  it("reads result / structured_output / is_error", () => {
    expect(parseEnvelope('{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"s"}')).toEqual({ text: "hi", structured: undefined, isError: false });
    expect(parseEnvelope('{"type":"result","is_error":false,"result":"","structured_output":{"a":1}}').structured).toEqual({ a: 1 });
    expect(parseEnvelope('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"x"}').isError).toBe(true);
  });
  it("accepts an array of messages (old builds) and raw text", () => {
    expect(parseEnvelope('[{"type":"system"},{"type":"result","result":"ok","is_error":false}]').text).toBe("ok");
    expect(parseEnvelope("plain text").text).toBe("plain text");
  });
});

describe("runClaude", () => {
  const base = { bin: STUB_BIN, cwd: REPO_DIR, tier: "fast" as const, timeoutMs: 5000 };

  it("returns the envelope text and records flags from feature detection", async () => {
    const dir = stubDir();
    resetFeatureCache();
    const r = await runClaude({ ...base, prompt: "hello", schema: { type: "object" }, env: stubEnv(dir, "valid", "answer") });
    expect(r.text).toBe("answer");
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    const argv = readFileSync(`${dir}/argv.log`, "utf8");
    expect(argv).toContain("-p --output-format json --model haiku");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--json-schema");
    expect(argv).not.toContain("--max-turns");
    expect(readFileSync(`${dir}/prompt-1.txt`, "utf8")).toBe("hello");
  });

  it("returns structured_output when present", async () => {
    const dir = stubDir();
    const r = await runClaude({ ...base, prompt: "p", env: stubEnv(dir, "structured", { k: 1 }) });
    expect(r.structured).toEqual({ k: 1 });
  });

  it("maps tiers to models", () => {
    const f = { jsonSchema: true, maxTurns: true, noSessionPersistence: false, tools: true };
    expect(buildArgs("write", f)).toEqual(["-p", "--output-format", "json", "--model", "sonnet", "--max-turns", "1", "--tools", ""]);
    expect(buildArgs("tailor", f)[4]).toBe("opus");
  });

  it("feature detection tolerates a broken binary", async () => {
    resetFeatureCache();
    const f = await detectFeatures("/nonexistent/claude-bin");
    expect(f).toEqual({ jsonSchema: false, maxTurns: false, noSessionPersistence: false, tools: false });
    resetFeatureCache();
  });

  it("throws ClaudeError on is_error and on non-zero exit with stderr tail", async () => {
    const dir = stubDir();
    await expect(runClaude({ ...base, prompt: "p", env: stubEnv(dir, "is_error") })).rejects.toThrow(/Invalid API key/);
    const err = await runClaude({ ...base, prompt: "p", env: stubEnv(dir, "exit1") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeError);
    expect((err as ClaudeError).exitCode).toBe(1);
    expect((err as ClaudeError).stderrTail).toContain("boom");
  });

  it("kills the process on timeout", async () => {
    const dir = stubDir();
    const t0 = Date.now();
    const err = await runClaude({ ...base, prompt: "p", timeoutMs: 300, env: stubEnv(dir, "sleep", "x", { STUB_SLEEP: "5" }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeError);
    expect((err as ClaudeError).timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("runs at most two claude processes at once (global semaphore)", async () => {
    const dir = stubDir();
    const env = stubEnv(dir, "sleep", "x", { STUB_SLEEP: "0.3" });
    await Promise.all(["a", "b", "c"].map((prompt) => runClaude({ ...base, prompt, env })));
    const lines = readFileSync(`${dir}/timeline`, "utf8").trim().split("\n");
    const starts = lines.filter((l) => l.startsWith("start")).map((l) => Number(l.split(" ")[1])).sort((x, y) => x - y);
    const ends = lines.filter((l) => l.startsWith("end")).map((l) => Number(l.split(" ")[1])).sort((x, y) => x - y);
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
    expect(starts[2]!).toBeGreaterThanOrEqual(ends[0]!); // the third waits for a free slot
  });
});

describe("mutex", () => {
  it("one slot: runs tasks one after another and survives rejections", async () => {
    const m = createMutex(1);
    const order: string[] = [];
    const p1 = m.run(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      throw new Error("x");
    });
    const p2 = m.run(async () => {
      order.push("b");
      return 2;
    });
    await expect(p1).rejects.toThrow("x");
    expect(await p2).toBe(2);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("two slots: the second runs alongside the first, the third waits", async () => {
    const m = createMutex(2);
    let live = 0;
    let peak = 0;
    const task = () => m.run(async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 20));
      live--;
    });
    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(2);
    expect(m.pending).toBe(0);
  });
});
