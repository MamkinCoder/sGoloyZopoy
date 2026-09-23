import { describe, expect, it } from "vitest";
import { searchUrl } from "../../src/hh/urls.js";

describe("searchUrl", () => {
  it("adds one professional_role per id, none when roles are empty", () => {
    const u = new URL(searchUrl({ query: "go", roles: ["96", "160"] }));
    expect(u.searchParams.get("text")).toBe("go");
    expect(u.searchParams.getAll("professional_role")).toEqual(["96", "160"]);
    expect(new URL(searchUrl({ query: "go" })).searchParams.has("professional_role")).toBe(false);
  });
});
