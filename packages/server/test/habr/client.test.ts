// Habr Career client offline: state parsing from the recorded pages (scrubbed fixtures) and the apply /
// chat flows on a FakeSession. The dry run must never click «Откликнуться»: on Habr that click sends.
import { describe, expect, it } from "vitest";
import { Status, type Vacancy } from "@sgz/shared";
import { SEL, createHabrClient } from "../../src/habr/client.js";
import { experienceSaved, guardProposal, resolveHabrSkills, toRedactorHtml } from "../../src/habr/resume.js";
import { extractSsrState, parseExperiences, parseJsonPage, parseListing, parseVacancyState } from "../../src/habr/state.js";
import { FakeSession } from "../hh/fake-session.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = (name: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");
const client = createHabrClient({ settleMs: 0, confirmTimeoutMs: 10 });
const URL = "https://career.habr.com/vacancies/1000168408";

const vacancy: Vacancy = {
  id: 1,
  source: "habr",
  externalId: "1000168408",
  url: URL,
  title: "Senior Go Backend Developer",
  company: "IT-hunter",
  salaryFrom: 0,
  salaryTo: 0,
  currency: "",
  descriptionText: "Go",
  hasTest: false,
  requiresLetter: false,
  area: "",
  workFormat: "",
  publishedAt: null,
  firstSeenAt: "2026-09-24T00:00:00Z",
  lastSeenAt: "2026-09-24T00:00:00Z",
  archived: false,
  dedupHash: "x",
};

/** The direct vacancy page with its ssr-state edited (kind, responsesLeft, our response). */
function editedVacancy(edit: (state: Record<string, any>) => void): string {
  const html = fixture("vacancy-direct.html");
  const state = extractSsrState(html) as Record<string, any>;
  edit(state);
  return html.replace(/(<script type="application\/json" data-ssr-state="true">)[\s\S]*?(<\/script>)/, (_, a: string, b: string) => `${a}${JSON.stringify(state)}${b}`);
}
const respondedPage = (message: string | null) =>
  editedVacancy((st) => {
    st.createResponse.response = { id: 1, message, messageHtml: message ? `<p>${message}</p>` : null };
    st.vacancy.response = { kind: "applied" };
  });

describe("habr state parsing", () => {
  it("reads a vacancy that can be applied to directly", () => {
    const st = parseVacancyState(extractSsrState(fixture("vacancy-direct.html")))!;
    expect(st).toMatchObject({ externalId: "1000168408", title: "Senior Go Backend Developer", company: "IT-hunter", kind: "direct", responded: false, responsesLeft: 141, placeholder: "", archived: false, login: "yarik_balak", workFormat: "Можно удалённо" });
    expect(st.descriptionText).toContain("PostgreSQL");
    expect(st.descriptionText).not.toContain("<p>");
  });

  it("reads our existing response", () => {
    const st = parseVacancyState(extractSsrState(fixture("vacancy-applied.html")))!;
    expect(st).toMatchObject({ kind: "applied", responded: true, responsesLeft: 141, company: "Альфа-Деньги", area: "Москва" });
  });

  it("reads the logged-in listing with the already-responded flag", () => {
    const r = parseListing(parseJsonPage(fixture("listing.html")));
    expect(r.totalPages).toBe(2);
    expect(r.cards).toHaveLength(3);
    expect(r.cards.map((c) => c.alreadyApplied)).toEqual([false, true, false]);
    expect(r.cards[0]).toMatchObject({ externalId: "1000168517", url: "https://career.habr.com/vacancies/1000168517", title: "Golang разработчик", company: "BGStaff" });
  });

  it("reads experience edit ids from the experiences page", () => {
    const e = parseExperiences(fixture("experiences.html"));
    expect(e.map((x) => x.id)).toEqual(["5127103", "5127104", "5127105", "5127106", "5127107"]);
    expect(e.map((x) => x.company)).toEqual(["Era2.ai", "Shadowlos КВН", "panteric.ru", "Яндекс", "Regalit consulting"]);
  });
});

describe("habr apply", () => {
  it("dry run reads the page and never clicks (the click itself sends)", async () => {
    const s = new FakeSession({ [URL]: { html: fixture("vacancy-direct.html"), existing: [SEL.applyButton] } });
    const r = await client.apply(s, { vacancy, coverLetter: "Привет! Готов обсудить детали.", dryRun: true });
    expect(r.status).toBe(Status.SKIP_DRY_RUN);
    expect(r.responsesLeft).toBe(141);
    expect(s.methods()).not.toContain("click");
    expect(s.methods()).not.toContain("fill");
    expect(s.acts()).toHaveLength(0);
  });

  it("clicks, fills the letter, submits and verifies by reloading", async () => {
    let clicked = false;
    const s = new FakeSession(
      { [URL]: { html: fixture("vacancy-direct.html"), existing: [SEL.applyButton] } },
      {
        onGoto: (_u, f) => {
          if (clicked) f.setPage({ html: respondedPage("Привет! Готов обсудить детали.") });
        },
        onClick: (sel, f) => {
          if (sel === SEL.applyButton) {
            clicked = true;
            f.setPage({ existing: [SEL.sent, SEL.letter[0], SEL.letterSubmit] });
          }
        },
      },
    );
    const r = await client.apply(s, { vacancy, coverLetter: "Привет! Готов обсудить детали.", dryRun: false });
    expect(r).toMatchObject({ status: Status.SENT, reasonDetail: "sent with letter", responsesLeft: 141 });
    const steps = s.calls.filter((c) => c.method === "click" || c.method === "fill").map((c) => [c.method, c.args[0]]);
    expect(steps).toEqual([
      ["click", SEL.applyButton],
      ["fill", SEL.letter[0]],
      ["click", SEL.letterSubmit],
    ]);
    expect(s.calls.filter((c) => c.method === "goto")).toHaveLength(2);
  });

  it("an error after «Откликнуться» (the click already sent) is SENT when Habr shows the response, letter not saved", async () => {
    let clicked = false;
    const s = new FakeSession(
      { [URL]: { html: fixture("vacancy-direct.html"), existing: [SEL.applyButton] } },
      {
        onGoto: (_u, f) => {
          if (clicked) f.setPage({ html: respondedPage(null) });
        },
        onClick: (sel, f) => {
          if (sel === SEL.applyButton) {
            clicked = true;
            f.setPage({ existing: [SEL.sent, SEL.letter[0]] }); // no «Дополнить» button: the act fallback throws
          }
        },
        onAct: () => {
          throw new Error("stagehand: LLM error");
        },
      },
    );
    const r = await client.apply(s, { vacancy, coverLetter: "Привет! Готов обсудить детали.", dryRun: false });
    expect(r).toMatchObject({ status: Status.SENT, reasonDetail: "sent, letter NOT saved: stagehand: LLM error" });
  });

  it("reports no confirmation when the reloaded page has no response", async () => {
    const s = new FakeSession({ [URL]: { html: fixture("vacancy-direct.html"), existing: [SEL.applyButton] } });
    const r = await client.apply(s, { vacancy, coverLetter: "", dryRun: false });
    expect(r.status).toBe(Status.FAILED_NO_CONFIRMATION);
    expect(s.snapshots).toEqual(["1000168408-confirm"]);
  });

  it("skips external apply, our own response, and a nearly used-up response allowance without clicking", async () => {
    const run = async (html: string) => {
      const s = new FakeSession({ [URL]: { html, existing: [SEL.applyButton] } });
      const r = await client.apply(s, { vacancy, coverLetter: "x", dryRun: false });
      expect(s.methods()).not.toContain("click");
      return r;
    };
    expect((await run(editedVacancy((st) => (st.vacancy.response = { kind: "external" })))).status).toBe(Status.SKIP_FILTER);
    expect((await run(fixture("vacancy-applied.html").replace(/1000167818/g, "1000168408"))).status).toBe(Status.SKIP_ALREADY_APPLIED);
    expect(await run(editedVacancy((st) => (st.createResponse.responsesLeft = 5)))).toMatchObject({ status: Status.SKIP_LIMIT, responsesLeft: 5 });
  });

  it("treats a login redirect as an expired session", async () => {
    const s = new FakeSession({ "https://career.habr.com/responses": { redirect: "https://account.habr.com/ru/login/?consumer=career" } });
    expect(await client.checkLogin(s)).toBe(false);
  });
});

describe("habr conversations", () => {
  const CONV = "https://career.habr.com/conversations/contact1";

  it("lists conversations from the Nuxt payload", async () => {
    const s = new FakeSession({ "https://career.habr.com/conversations": { html: fixture("conversation.html") } });
    const r = await client.listConversations(s);
    expect(r.conversations).toHaveLength(10);
    expect(r.myAvatar).toMatch(/^https:\/\/habrastorage\.org\/.+\.jpg$/);
    expect(r.conversations[0]).toMatchObject({ login: "contact1", unread: 0, lastMessage: { isMine: true, kind: "message" } });
    expect(r.conversations[1]).toMatchObject({ company: "Далее/", lastMessage: { isMine: false, kind: "question" } });
  });

  it("reads messages and tells ours apart by the avatar", async () => {
    const s = new FakeSession({ [CONV]: { html: fixture("conversation.html"), existing: [SEL.message, SEL.chatInput] } });
    const t = await client.readConversation(s, "contact1");
    expect(t.writable).toBe(true);
    expect(t.messages.map((m) => m.mine)).toEqual([true, false, true, false, true, true]);
    expect(t.messages[1]).toMatchObject({ id: "571269082", text: "Да, актуально! Готов обсудить детали." });
  });

  it("an unrendered conversation is an error, never an empty one (a send retry would post the reply twice)", async () => {
    const s = new FakeSession({ [CONV]: { html: fixture("conversation.html"), existing: [SEL.chatInput] } });
    await expect(client.readConversation(s, "contact1")).rejects.toThrow(/messages not rendered/);
  });

  it("a listing that is not JSON (DDoS-Guard, rate limit) aborts instead of looking like no vacancies", async () => {
    const s = new FakeSession({ "https://career.habr.com/api/frontend/vacancies": { html: "<html><title>DDoS-Guard</title></html>" } });
    await expect(client.search(s, "go", 0)).rejects.toMatchObject({ status: Status.FAILED_UI });
  });

  it("sends a message and waits for it to appear", async () => {
    const s = new FakeSession({ [CONV]: { html: fixture("conversation.html"), existing: [SEL.chatInput, SEL.chatSend] } }, { onWaitForText: () => true });
    await s.goto(CONV);
    await client.sendMessage(s, "contact1", "Да, готов созвониться.");
    expect(s.calls.filter((c) => c.method === "fill" || c.method === "click").map((c) => c.args[0])).toEqual([SEL.chatInput, SEL.chatSend]);
  });
});

describe("habr resume proposal guard", () => {
  it("keeps skills to the facts, caps lengths and experiences to Habr's own places", () => {
    const p = guardProposal(
      {
        title: "Fullstack-разработчик: Go, Node.js, Python, React, AI/LLM, DevOps и ещё очень много всего интересного сверх лимита",
        specializations: [4, 2, 3, 999],
        qualification: "Senior",
        about: "  Абзац один.\n\nАбзац два.  ",
        skills: ["Golang", "Node.js", "Kubernetes", "Vue.js", "golang", "1C"],
        experiences: [
          { company: "Era2.ai", description: "Делал API." },
          { company: "Выдуманная компания", description: "x" },
        ],
        notes: [],
      },
      ["Go", "Node.js", "Vue", "Kubernetes"],
      { never_claim_skills: ["Kubernetes"] },
      ["Era2.ai", "Яндекс"],
    );
    expect(p.title.length).toBeLessThanOrEqual(80);
    expect(p.specializations).toEqual([4, 2]);
    expect(p.skills).toEqual(["Golang", "Node.js", "Vue.js"]);
    expect(p.experiences.map((e) => e.company)).toEqual(["Era2.ai"]);
    expect(p.notes.join("\n")).toMatch(/Kubernetes[\s\S]*1C[\s\S]*Выдуманная компания/);
    expect(toRedactorHtml("Раз.\nДва <b>\n\n- три")).toBe("<p>Раз.<br>Два &lt;b&gt;</p><p>- три</p>");
  });

  it("strips never_claim skills from «о себе» and job descriptions", () => {
    const p = guardProposal(
      { title: "Go", specializations: [2], qualification: "Middle", about: "Пишу на Go. Настраивал Kubernetes в проде.", skills: [], experiences: [{ company: "Era2.ai", description: "Делал API. Поднял кластер Kubernetes." }], notes: [] },
      ["Go"],
      { never_claim_skills: ["Kubernetes"] },
      ["Era2.ai"],
    );
    expect(p.about).not.toMatch(/Kubernetes/);
    expect(p.experiences[0]!.description).not.toMatch(/Kubernetes/);
    expect(p.notes.join("\n")).toMatch(/о себе/);
    expect(p.notes.join("\n")).toMatch(/опыт Era2\.ai/);
  });

  it("maps skills to Habr titles exactly or narrower, never to a wider title (SQL is not Microsoft SQL Server)", async () => {
    const dict: Record<string, string[]> = { SQL: ["Microsoft SQL Server", "Oracle SQL"], Go: ["Golang"], "REST API": ["REST"] };
    const r = await resolveHabrSkills(["SQL", "Go", "REST API"], async (u) => ({ list: (dict[decodeURIComponent(u.split("term=")[1]!)] ?? []).map((title) => ({ title })) }));
    expect(r.skills).toEqual(["Golang", "REST"]);
    expect(r.wider).toEqual([{ name: "SQL", title: "Microsoft SQL Server" }]);
  });

  it("an experience save counts only on a 2xx answer without validation errors", () => {
    expect(experienceSaved({ status: 200, body: "$('#experience').replaceWith(...)" })).toBe(true);
    expect(experienceSaved({ status: 422, body: "" })).toBe(false);
    expect(experienceSaved({ status: 200, body: "<div class=\"field_with_errors\">" })).toBe(false);
    expect(experienceSaved({ status: 0, body: "no form" })).toBe(false);
    // Habr's real success reply (it clears errors and redirects)
    expect(experienceSaved({ status: 200, body: "window.helpers.clear_form_errors(); window.helpers.notify('Настройки успешно сохранены'); document.location.href = \"/profile/experiences\";" })).toBe(true);
    // Habr's real validation reply
    expect(experienceSaved({ status: 200, body: "form_element.after('<span class=\"validation-error\">Укажите квалификацию</span>');" })).toBe(false);
  });
});
