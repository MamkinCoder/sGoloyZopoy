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
