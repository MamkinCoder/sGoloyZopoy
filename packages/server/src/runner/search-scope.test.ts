import { describe, expect, it } from "vitest";
import { searchUrl } from "../hh/urls.js";
import { IT_ROLES, searchScope } from "./hh.js";

describe("hh search scope", () => {
  it("developers search the IT roles, managers search titles in every role", () => {
    expect(searchScope({ directions: ["go-backend", "other"], extra: {} })).toEqual({ roles: IT_ROLES });
    expect(searchScope({ directions: ["other"], extra: {} })).toEqual({ titleOnly: true });
    expect(searchScope({ directions: ["other"], extra: { search_scope: "it" } })).toEqual({ roles: IT_ROLES });
    expect(searchScope({ directions: ["go-backend"], extra: { search_scope: "any" } })).toEqual({ titleOnly: true });
    const url = searchUrl({ query: "operations manager", ...searchScope({ directions: ["other"], extra: {} }) });
    expect(url).toContain("search_field=name");
    expect(url).not.toContain("professional_role");
  });
});

describe("career keywords", () => {
  it("a manager's discovery keeps manager titles, a developer's keeps the developer list", async () => {
    const { careerKeywords } = await import("./career.js");
    const mgr = careerKeywords({ directions: ["other"], extra: { target_role: "Project manager, Operations manager" }, hh_queries: ["delivery manager"] });
    expect(mgr).toContain("менеджер");
    expect(mgr).toContain("project");
    expect(mgr).not.toContain("golang");
    expect(careerKeywords({ directions: ["go-backend"], extra: {}, hh_queries: ["go"] })).toContain("golang");
  });
});
