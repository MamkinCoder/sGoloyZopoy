import { describe, expect, it } from "vitest";
import { agyModel, buildAgyArgs, parseAgyOutput } from "./agy.js";

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
