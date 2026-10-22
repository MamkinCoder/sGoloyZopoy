import { describe, expect, it, vi } from "vitest";
import type { User } from "@sgz/shared";
import { mentions, parseSalary } from "./build.js";
import { createOnboarding, type OnboardDeps } from "./flow.js";

const LLM_ANSWER = {
  summary: "Backend-разработчик.",
  experience: "3 года backend",
  directions: ["go-backend", "bogus"],
  hh_queries: ["golang разработчик", "backend go"],
  verified_skills: ["Go", "Rust"], // Rust was never named: the guard drops it
  cv: { title: "Go Developer", about: "x", skills: [{ name: "Языки", items: ["Go", "Rust"] }], jobs: [], education: [] },
};

function setup(over: Partial<OnboardDeps> = {}) {
  const settings = new Map<string, string>();
  const users: User[] = [];
  const saved: unknown[] = [];
  const deps: OnboardDeps = {
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => void settings.set(k, v),
      listUsers: () => users,
      getProfile: () => null,
      upsertUser: (u) => {
        const i = users.findIndex((x) => x.id === u.id || x.slug === u.slug);
        const row = { ...u, id: i >= 0 ? users[i]!.id : users.length + 1 } as User;
        if (i >= 0) users[i] = row;
        else users.push(row);
        return row;
      },
    },
    llm: { json: vi.fn(async () => LLM_ANSWER) } as never,
    notifier: { report: async () => undefined, alert: async () => undefined, ask: async () => undefined },
    connector: { begin: vi.fn(async () => undefined), finish: vi.fn(async () => true) },
    pdfText: async () => "x".repeat(300),
    save: (u, d) => void saved.push([u.slug, d.profile]),
    prepareHh: async () => "ok",
    proposeHabr: async () => "proposal",
    applyHabr: async () => undefined,
    habrLoggedIn: () => true,
    now: () => new Date("2026-10-19T00:00:00Z"),
    ...over,
  };
  return { ob: createOnboarding(deps), deps, settings, users, saved };
}

describe("parseSalary / mentions", () => {
  it("reads thousands and ranges", () => {
    expect(parseSalary("от 200 до 300 тысяч")).toEqual([200000, 300000]);
    expect(parseSalary("250 000")).toEqual([250000, 0]);
    expect(parseSalary("")).toEqual([0, 0]);
  });
  it("matches skills as words", () => {
    expect(mentions("Go, React", "Go")).toBe(true);
    expect(mentions("a good dev", "Go")).toBe(false);
    expect(mentions("C++ and C#", "C#")).toBe(true);
  });
});

describe("onboarding conversation", () => {
  it("invite → questions → profile guarded by the person's own skills → hh and Habr connected → active", async () => {
    let ready!: () => void;
    const gate = new Promise<void>((r) => (ready = r));
    const { ob, deps, users, saved } = setup({ proposeHabr: async () => (await gate, "proposal") });
    expect(ob.redeem("7", "/start deadbeef")).toBeNull(); // unknown code: silence
    const code = /\/start (\w+)/.exec(ob.invite())![1]!;
    expect(ob.redeem("7", `/start ${code}`)).toContain("Как тебя зовут");
    expect(ob.redeem("8", `/start ${code}`)).toBeNull(); // single use
    expect(users[0]).toMatchObject({ tgChatId: "7", active: false });

    expect(await ob.text("7", "Аня")).toContain("PDF");
    expect(await ob.document("7", { name: "cv.pdf", size: 1000, download: async () => Buffer.alloc(1) })).toContain("Кем хочешь");
    await ob.text("7", "backend на Go");
    await ob.text("7", "Go, PostgreSQL");
    await ob.text("7", "3 года");
    await ob.text("7", "от 200 тысяч");
    const confirm = await ob.text("7", "Москва, удалёнка");
    expect(confirm).toContain("Навыки: Go, PostgreSQL");
    expect(confirm).not.toContain("Rust");
    expect(confirm).toContain("go-backend");

    expect(await ob.text("7", "ок")).toContain("Подключаем hh.ru");
    expect(saved).toHaveLength(1);
    expect(await ob.text("7", "anya@example.com")).toContain("Пришли код");
    expect(deps.connector.begin).toHaveBeenCalledWith("hh", "u7", "anya@example.com");
    expect(await ob.text("7", "12 34 56")).toContain("hh.ru подключён");
    expect(await ob.text("7", "anya@example.com")).toContain("пароль");
    const removed = vi.fn(async () => undefined);
    expect(await ob.text("7", "secret", { remove: removed })).toContain("Готовлю резюме");
    expect(removed).toHaveBeenCalled();
    expect(await ob.text("7", "ок")).toContain("Ещё готовлю");
    ready();
    await vi.waitFor(async () => expect(await ob.text("7", "ок")).toContain("Готово"));
    expect(users[0]).toMatchObject({ active: true, name: "Аня" });
    expect(ob.active("7")).toBe(false);
  });

  it("a wrong hh code keeps the step; skipping both leaves the user connected to nothing", async () => {
    const { ob, deps } = setup({ connector: { begin: async () => undefined, finish: async () => false } });
    const code = /\/start (\w+)/.exec(ob.invite())![1]!;
    ob.redeem("7", `/start ${code}`);
    for (const t of ["Аня", "нет", "devops", "Docker", "2 года", "пропустить", "Москва"]) await ob.text("7", t);
    await ob.text("7", "ок");
    await ob.text("7", "+7 900 111 22 33");
    expect(await ob.text("7", "111111")).toContain("Код не подошёл");
    expect(await ob.text("7", "пропустить")).toContain("Хабр");
    expect(await ob.text("7", "пропустить")).toContain("ни hh.ru, ни Хабр не подключены");
    expect(deps.store.getSetting("onboard:7")).toBe("");
  });

  it("an unfinished onboarding is resumed (current question again); «заново» restarts; a failed build does not leak the error to the user", async () => {
    const alerts: string[] = [];
    const { ob, users } = setup({
      llm: { json: vi.fn(async () => { throw new Error("claude exited with code 1: OAuth session expired"); }) } as never,
      notifier: { report: async () => undefined, alert: async (t: string, b: string) => void alerts.push(`${t}: ${b}`), ask: async () => undefined },
    });
    const code = /\/start (\w+)/.exec(ob.invite())![1]!;
    ob.redeem("7", `/start ${code}`);
    for (const t of ["Аня", "нет", "devops", "Docker", "2 года", "пропустить"]) await ob.text("7", t);
    const failed = await ob.text("7", "Москва");
    expect(failed).not.toContain("claude");
    expect(alerts[0]).toContain("OAuth session expired");
    const user = users[0]!;
    expect(ob.resume(user, "7")).toMatch(/Продолжаем.*\n\nОткуда ты/s);
    expect(ob.resume(user, "7", true)).toContain("Как тебя зовут");
  });

  it("«готово» at the Habr step uses a login the owner saved: no password, straight to the proposal", async () => {
    const { ob, users } = setup();
    const code = /\/start (\w+)/.exec(ob.invite())![1]!;
    ob.redeem("7", `/start ${code}`);
    for (const t of ["Аня", "нет", "devops", "Docker", "2 года", "пропустить", "Москва", "ок", "пропустить"]) await ob.text("7", t);
    expect(await ob.text("7", "готово")).toContain("Готовлю резюме");
    await vi.waitFor(async () => expect(await ob.text("7", "ок")).toContain("Готово"));
    expect(users[0]!.active).toBe(true);
  });

  it("rejects a non-PDF and a chat without onboarding stays silent", async () => {
    const { ob } = setup();
    expect(await ob.text("1", "привет")).toBeNull();
    expect(await ob.document("1", { name: "a.pdf", size: 1, download: async () => Buffer.alloc(0) })).toBeNull();
    const code = /\/start (\w+)/.exec(ob.invite())![1]!;
    ob.redeem("7", `/start ${code}`);
    await ob.text("7", "Аня");
    expect(await ob.document("7", { name: "cv.docx", size: 1, download: async () => Buffer.alloc(0) })).toContain("PDF");
  });
});

describe("normalizePhone", () => {
  it("makes a full international number for hh's phone field", async () => {
    const { normalizePhone } = await import("./connect.js");
    expect(["8 900 111-22-33", "900 111 22 33", "+375 29 123-45-67", "79001112233"].map(normalizePhone)).toEqual(["+79001112233", "+79001112233", "+375291234567", "+79001112233"]);
  });
});
