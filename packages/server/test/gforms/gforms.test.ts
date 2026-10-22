import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBody, extractFormUrls, formKey, formQuestions, missingRequired, parseForm, submitForm, viewUrl } from "../../src/gforms/index.js";

const data = [
  null,
  [
    "О нас",
    [
      [1, "ФИО", null, 1, [[11, null, 1]]],
      [2, "Доход", null, 0, [[12, null, 0, null, [[1]]]]],
      [3, "Формат", null, 2, [[13, [["Офис", null, null, null, 0], ["Удалёнка", null, null, null, 0], ["", null, null, null, 1]], 1]]],
      [4, "Стек", null, 4, [[14, [["Go"], ["Node"]], 0]]],
    ],
  ],
  "/forms",
  "Backend 2026",
];
const html = `<form action="https://docs.google.com/forms/d/e/ABC/formResponse" method="POST"><input type="hidden" name="fvv" value="1"><input type="hidden" name="partialResponse" value="[null,null,&quot;77&quot;]"><input type="hidden" name="fbzx" value="77"></form><script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(data)};</script>`;
const url = "https://docs.google.com/forms/d/e/ABC/viewform";

afterEach(() => vi.unstubAllGlobals());

describe("google forms", () => {
  it("finds links in a message", () => {
    expect(extractFormUrls(`Заполните (${url}?usp=sf_link), и ещё https://forms.gle/Xy_9z.`)).toEqual([`${url}?usp=sf_link`, "https://forms.gle/Xy_9z"]);
    expect(formKey(`${url}?x=1`)).toBe("ABC");
    expect(viewUrl("https://docs.google.com/forms/d/e/ABC/viewform?usp=pp_url")).toBe(url);
  });

  it("parses questions, skips the «other» option, reads hidden fields", () => {
    const f = parseForm(html, url);
    expect(f.title).toBe("Backend 2026");
    expect(f.unsupported).toEqual([]);
    expect(f.questions.map((q) => [q.entry, q.kind, q.required, q.options])).toEqual([
      ["11", "text", true, []],
      ["12", "number", false, []],
      ["13", "radio", true, ["Офис", "Удалёнка"]],
      ["14", "checkbox", false, ["Go", "Node"]],
    ]);
    expect(formQuestions(f)[2]).toMatchObject({ idx: 2, kind: "radio", options: ["Офис", "Удалёнка"] });
    expect(f.hidden.partialResponse).toBe('[null,null,"77"]');
  });

  it("builds the submission body from answers", () => {
    const f = parseForm(html, url);
    const answers = [{ idx: 0, text: "Иван" }, { idx: 1, text: "400000" }, { idx: 2, option_idx: 1 }, { idx: 3, option_idxs: [0, 1] }];
    const b = buildBody(f, answers);
    expect(b.get("entry.11")).toBe("Иван");
    expect(b.get("entry.13")).toBe("Удалёнка");
    expect(b.getAll("entry.14")).toEqual(["Go", "Node"]);
    expect(b.get("fbzx")).toBe("77");
    expect(b.get("pageHistory")).toBe("0");
    expect(missingRequired(f, [{ idx: 0, text: "x" }])).toEqual(["Формат"]);
  });

  it("flags what it cannot fill", () => {
    const d = structuredClone(data) as unknown[][];
    ((d[1] as unknown[])[1] as unknown[][]).push([5, "CV", null, 13, [[15, null, 1]]], [6, "Куда", null, 2, [[16, [["A", null, 7, null, 0]], 1]]]);
    const f = parseForm(html.replace(JSON.stringify(data), JSON.stringify(d)), url);
    expect(f.unsupported).toHaveLength(2);
  });

  it("expands a grid into one question per row", () => {
    const d = structuredClone(data) as unknown[][];
    const rows = ["Playwright", "Selenium"].map((r, i) => [90 + i, [["None"], ["1-2 years"], ["4+ years"]], 1, [r], null, null, null, null, null, null, null, [0]]);
    ((d[1] as unknown[])[1] as unknown[][]).push([7, "Years with tools", null, 7, rows]);
    const f = parseForm(html.replace(JSON.stringify(data), JSON.stringify(d)), url);
    expect(f.unsupported).toEqual([]);
    expect(f.questions.slice(4).map((q) => [q.entry, q.title, q.kind, q.options.length])).toEqual([
      ["90", "Years with tools - Playwright", "radio", 3],
      ["91", "Years with tools - Selenium", "radio", 3],
    ]);
  });

  it("submits and checks the confirmation", async () => {
    const f = parseForm(html, url);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('<div class="freebirdFormviewerViewResponseConfirmationMessage">ok</div>')).mockResolvedValueOnce(new Response("<form>error</form>"));
    vi.stubGlobal("fetch", fetchMock);
    await submitForm(f, [{ idx: 0, text: "Иван" }, { idx: 2, option_idx: 0 }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://docs.google.com/forms/d/e/ABC/formResponse");
    await expect(submitForm(f, [])).rejects.toThrow(/не подтвердил/);
  });
});
