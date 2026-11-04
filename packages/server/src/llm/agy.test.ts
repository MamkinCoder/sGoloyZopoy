import { describe, expect, it } from "vitest";
import { agyModel, agyProxyEnv, buildAgyArgs, parseAgyOutput } from "./agy.js";

describe("agy goes through the VPN proxy only", () => {
  it("passes the proxy in every spelling, SGZ_LLM_PROXY first", () => {
    const e = agyProxyEnv({ HTTPS_PROXY: "http://a:1", SGZ_LLM_PROXY: "http://b:2" });
    expect([e.HTTPS_PROXY, e.https_proxy, e.ALL_PROXY, e.http_proxy]).toEqual(["http://b:2", "http://b:2", "http://b:2", "http://b:2"]);
  });
  it("refuses to run without a proxy unless SGZ_LLM_DIRECT=1", () => {
    expect(() => agyProxyEnv({})).toThrow(/refusing to call Google directly/);
    expect(agyProxyEnv({ SGZ_LLM_DIRECT: "1" })).toEqual({});
  });
});

describe("agy wrapper", () => {
  it("maps tiers to models, overridable by env", () => {
    expect(agyModel("write", {})).toBe("claude-sonnet-4-6");
    expect(agyModel("fast", {})).toBe("gemini-3.8-flash-medium");
    expect(agyModel("tailor", { AGY_MODEL_TAILOR: "claude-opus-4-6-thinking" })).toBe("claude-opus-4-6-thinking");
  });
  it("puts the whole prompt in --print=", () => {
    expect(buildAgyArgs("write", "привет", {})).toEqual(["--model", "claude-sonnet-4-6", "--output-format", "json", "--print=привет"]);
  });
  it("reads the envelope and reports a failed status", () => {
    expect(parseAgyOutput('{"status":"SUCCESS","response":"[1]"}')).toEqual({ text: "[1]", isError: false });
    expect(parseAgyOutput('{"status":"ERROR","error":"quota"}')).toEqual({ text: "quota", isError: true });
    expect(parseAgyOutput("plain")).toEqual({ text: "plain", isError: false });
  });
});
