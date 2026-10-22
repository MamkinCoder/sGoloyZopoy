import { describe, expect, it } from "vitest";
import { buildGeminiArgs, geminiModel, geminiProxyEnv, parseGeminiOutput } from "./gemini.js";

describe("gemini goes through the VPN proxy only", () => {
  it("passes the proxy in every spelling, SGZ_GEMINI_PROXY first", () => {
    const e = geminiProxyEnv({ HTTPS_PROXY: "http://a:1", SGZ_GEMINI_PROXY: "http://b:2" });
    expect([e.HTTPS_PROXY, e.http_proxy, e.ALL_PROXY, e.NODE_USE_ENV_PROXY]).toEqual(["http://b:2", "http://b:2", "http://b:2", "1"]);
    expect(e.NO_PROXY).toBe("127.0.0.1,localhost,::1");
  });
  it("refuses to run without a proxy unless SGZ_GEMINI_DIRECT=1", () => {
    expect(() => geminiProxyEnv({})).toThrow(/refusing to call Google directly/);
    expect(geminiProxyEnv({ SGZ_GEMINI_DIRECT: "1" })).toEqual({});
  });
});

describe("gemini wrapper", () => {
  it("tiers map to CLI model aliases, overridable by env", () => {
    expect([geminiModel("fast", {}), geminiModel("write", {}), geminiModel("tailor", {})]).toEqual(["flash", "pro", "pro"]);
    expect(geminiModel("write", { GEMINI_MODEL_WRITE: "gemini-3-pro-preview" })).toBe("gemini-3-pro-preview");
    expect(buildGeminiArgs("fast", {})).toEqual(["-p", expect.any(String), "-m", "flash", "-o", "json", "--skip-trust"]);
  });

  it("reads the json envelope, also after warning lines; plain text passes through; an error object is an error", () => {
    expect(parseGeminiOutput('{"response":"{\\"a\\":1}","stats":{}}')).toEqual({ text: '{"a":1}', isError: false });
    expect(parseGeminiOutput('Loaded cached credentials.\n{"response":"ok"}').text).toBe("ok");
    expect(parseGeminiOutput("просто текст")).toEqual({ text: "просто текст", isError: false });
    expect(parseGeminiOutput('{"error":{"message":"quota"}}')).toEqual({ text: "quota", isError: true });
  });
});
