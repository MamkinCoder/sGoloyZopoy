import { describe, expect, it } from "vitest";
import { canTap } from "./serve.js";

describe("canTap", () => {
  const users = [{ id: 1, tgChatId: "" }, { id: 2, tgChatId: "200" }];
  it("the owner's chat taps anyone's card", () => expect(canTap(users, "100", 2, "100")).toBe(true));
  it("a seeker's chat taps only her own cards", () => {
    expect(canTap(users, "100", 2, "200")).toBe(true);
    expect(canTap(users, "100", 1, "200")).toBe(false);
  });
  it("a card of a seeker without a chat belongs to the owner's chat", () => expect(canTap(users, "100", 1, "100")).toBe(true));
  it("a card without a user is open", () => expect(canTap(users, "100", undefined, "200")).toBe(true));
});
