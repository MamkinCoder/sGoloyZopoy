import { describe, expect, it } from "vitest";
import { defaultProfile } from "../config/profile.js";
import { openStore } from "../db/index.js";
import { seedDefaultUsers } from "../db/users.js";
import { FakeLLM } from "../llm/fake.js";
import { kbFor, renderKb, renderStory } from "./context.js";
import { guardSeed, ingestKb, saveIngested, seedKb, seedPrompt, type SeedSources } from "./llm.js";
import { allowedNumbers, applySeed, stripInventedNumbers, storyHash, syncProfileSkills, withKbSkills, type KbStoryDraft } from "./write.js";
import { KbSeedSchema } from "../llm/schemas.js";

const setup = () => {
  const store = openStore(":memory:");
  seedDefaultUsers(store);
  const user = store.getUserBySlug("yaroslav")!;
  return { store, uid: user.id };
};

const draft = (over: Partial<KbStoryDraft> = {}): KbStoryDraft => ({
  title: "Кэш на Redis",
  company: "era2.ai",
  period: "Июль 2026 - н.в.",
  context: "Агрегатор нейросетей.",
  did: "Сделал кэш ответов на Redis.",
  result: "Меньше обращений к платным провайдерам.",
  tags: ["Redis", "Go"],
  ...over,
});

const sources = (): SeedSources => ({
  profile: { ...defaultProfile(), verified_skills: ["Go", "Redis", "React"], never_claim_skills: ["Kubernetes"] },
  cvs: [
    {
      title: "Backend",
      about: "",
      skills: [],
      jobs: [{ company: "era2.ai", role: "Backend", period: "Июль 2026 - н.в.", location: "", summary: "", bullets: ["Интегрировал 198 AI-моделей"], stack: ["Go"] }],
      education: [],
    },
  ],
  habr: null,
});

describe("kb repo", () => {
  it("tags: upsert by name or alias, merge aliases, keep status unless given; stories: CRUD with tag links", () => {
    const { store, uid } = setup();
    const react = store.upsertKbTag(uid, { name: "React", aliases: ["react.js", "Реакт"], category: "frontend" });
    expect(react).toMatchObject({ name: "React", aliases: ["react.js", "Реакт"], status: "unknown", storyCount: 0 });
    const same = store.upsertKbTag(uid, { name: "реакт", aliases: ["ReactJS"], status: "yes" });
    expect(same).toMatchObject({ id: react.id, name: "React", status: "yes", category: "frontend" });
    expect(same.aliases).toEqual(["react.js", "Реакт", "ReactJS"]);
    expect(store.upsertKbTag(uid, { name: "REACT" }).status).toBe("yes");
    const go = store.upsertKbTag(uid, { name: "Go" });

    const s = store.saveKbStory({ userId: uid, title: "UI", company: "X", period: "", context: "", did: "Сделал UI", result: "", source: "panel", confirmed: false, hash: "", tagIds: [react.id, go.id, go.id] });
    expect(s.tags.map((t) => t.name)).toEqual(["Go", "React"]);
    expect(store.listKbTags(uid).find((t) => t.id === go.id)!.storyCount).toBe(1);
    expect(store.listKbStories(uid, react.id)).toHaveLength(1);

    const upd = store.saveKbStory({ ...s, did: "Сделал UI на React", confirmed: true, tagIds: [react.id] });
    expect(upd).toMatchObject({ id: s.id, did: "Сделал UI на React", confirmed: true, tags: [{ id: react.id, name: "React" }] });
    expect(store.listKbStories(uid, go.id)).toHaveLength(0);
    expect(store.setKbTagStatus(go.id, "no")!.status).toBe("no");

    store.deleteKbStory(s.id);
    expect(store.getKbStory(s.id)).toBeNull();
    expect(store.listKbTags(uid).every((t) => t.storyCount === 0)).toBe(true);
  });
});

describe("kb repo aliases", () => {
  it("an incoming alias naming an existing tag resolves to it; an alias naming another tag is dropped", () => {
    const { store, uid } = setup();
    const k8s = store.upsertKbTag(uid, { name: "Kubernetes", status: "no" });
    const docker = store.upsertKbTag(uid, { name: "Docker", status: "yes" });
    const same = store.upsertKbTag(uid, { name: "K8s", aliases: ["Kubernetes", "kube"] });
    expect(same).toMatchObject({ id: k8s.id, name: "Kubernetes", status: "no", aliases: ["kube", "K8s"] });
    // aliases naming two different tags: no merge, and neither alias stays (it would shadow its tag)
    const ambiguous = store.upsertKbTag(uid, { name: "Контейнеры", aliases: ["Docker", "Kubernetes", "OCI"] });
    expect(ambiguous).toMatchObject({ name: "Контейнеры", aliases: ["OCI"] });
    expect(store.listKbTags(uid).map((t) => t.id).sort()).toEqual([k8s.id, docker.id, ambiguous.id].sort());
  });
});

describe("kbFor", () => {
  it("an over-budget best story is shortened, a later one that does not fit leaves room for smaller ones", () => {
    const { store, uid } = setup();
    const add = (title: string, did: string) => store.saveKbStory({ userId: uid, title, company: "", period: "", context: "", did, result: "", source: "panel", confirmed: true, hash: "", tagIds: [] });
    const small = add("Маленькая", "Коротко."); // ids ascending: the newest ranks first at equal scores
    const big = add("Большая", "Средняя история. ".repeat(80));
    const huge = add("Огромная", "Длинное предложение про работу. ".repeat(200));
    const ids = kbFor({ listKbTags: () => [], listKbStories: () => [huge, big, small] }, uid, {}, 1500);
    expect(ids.stories.map((s) => s.id)).toEqual([huge.id, small.id]);
    expect(ids.stories.reduce((n, s) => n + renderStory(s).length + 2, 0)).toBeLessThanOrEqual(1500);
  });

  it("matches tags by alias, finds tags in free text, ranks by tag overlap then words, cuts to the budget", () => {
    const { store, uid } = setup();
    const redis = store.upsertKbTag(uid, { name: "Redis", status: "yes" });
    const react = store.upsertKbTag(uid, { name: "React", aliases: ["react.js"], status: "yes" });
    store.upsertKbTag(uid, { name: "Vitest", status: "no" });
    const add = (title: string, did: string, tagIds: number[], confirmed = false) =>
      store.saveKbStory({ userId: uid, title, company: "", period: "", context: "", did, result: "", source: "seed", confirmed, hash: "", tagIds });
    const cache = add("Кэш", "Кэширование ответов провайдеров", [redis.id]);
    const ui = add("Интерфейс", "Интерфейсы генерации", [react.id], true);
    const both = add("Fullstack", "Кэш и интерфейс", [redis.id, react.id]);
    add("Другое", "Биллинг", []);

    const byTags = kbFor(store, uid, { tags: ["react.js", "Vitest", "Kafka"] });
    expect(byTags.topics.map((t) => [t.name, t.status, t.tag?.name ?? null])).toEqual([
      ["react.js", "yes", "React"],
      ["Vitest", "no", "Vitest"],
      ["Kafka", "unknown", null],
    ]);
    expect(byTags.stories.map((s) => s.id)).toEqual([ui.id, both.id]);

    const byText = kbFor(store, uid, { text: "Работали с Redis? Нужно кэширование." });
    expect(byText.topics.map((t) => t.name)).toEqual(["Redis"]);
    expect(byText.stories[0]!.id).toBe(cache.id); // tag + word «кэширование»
    expect(byText.stories.map((s) => s.id)).toContain(both.id);

    expect(kbFor(store, uid, {}).stories).toHaveLength(4);
    expect(kbFor(store, uid, { tags: ["React"] }, 10).stories).toHaveLength(1);

    const block = renderKb(byTags);
    expect(block).toContain("- Vitest: нет в опыте, не заявлять");
    expect(block).toContain("- Kafka: нет в базе");
    expect(block).toContain("### Интерфейс [React]");
  });
});

describe("seed", () => {
  it("guardSeed: statuses from the profile, missing skills added, invented numbers and unknown companies dropped", () => {
    const seed = guardSeed(
      {
        tags: [{ name: "Golang", aliases: ["Go"], category: "language" }, { name: "Kubernetes", aliases: ["k8s"], category: "infra" }],
        stories: [
          draft({ result: "Интегрировал 198 AI-моделей. Ускорил ответы на 40%.", tags: ["Go", "Kubernetes"] }),
          draft({ company: "Google", period: "2019", did: "Писал сервисы." }),
          draft({ did: "Ускорил на 73%." }),
        ],
      },
      sources(),
    );
    expect(seed.tags.map((t) => [t.name, t.status])).toEqual([
      ["Golang", "yes"],
      ["Kubernetes", "no"],
      ["Redis", "yes"],
      ["React", "yes"],
    ]);
    expect(seed.stories).toHaveLength(2);
    expect(seed.stories[0]!.result).toBe("Интегрировал 198 AI-моделей.");
    expect(seed.stories[0]!.tags).toEqual(["Go"]);
    expect(seed.stories[1]).toMatchObject({ company: "", period: "" });
  });

  it("seedKb + applySeed: idempotent by hash, keeps human stories and human tag statuses, syncs the profile", async () => {
    const { store, uid } = setup();
    store.saveProfile(uid, { ...defaultProfile(), verified_skills: ["Go"], never_claim_skills: [] });
    const human = store.upsertKbTag(uid, { name: "React", status: "no" });
    store.saveKbStory({ userId: uid, title: "Моя", company: "", period: "", context: "", did: "Руками", result: "", source: "panel", confirmed: true, hash: "", tagIds: [] });

    const llm = new FakeLLM();
    llm.onJson = () => ({ tags: [{ name: "Redis", aliases: ["редис"], category: "database" }], stories: [draft(), draft({ title: "Второй", did: "Сделал второе." })] });
    const seed = await seedKb(llm, sources());
    expect(llm.calls[0]!.args[0]).toBe("kb_seed");

    const first = applySeed(store, uid, seed);
    expect(first).toMatchObject({ storiesAdded: 2, storiesSkipped: 0 });
    const again = applySeed(store, uid, JSON.parse(JSON.stringify(seed)));
    expect(again).toMatchObject({ tagsAdded: 0, storiesAdded: 0, storiesSkipped: 2 });

    expect(store.listKbStories(uid).map((s) => s.source).sort()).toEqual(["panel", "seed", "seed"]);
    expect(store.listKbStories(uid).filter((s) => s.source === "seed").every((s) => !s.confirmed)).toBe(true);
    expect(store.listKbTags(uid).find((t) => t.id === human.id)!.status).toBe("no"); // seed says yes, human said no
    const p = store.getProfile(uid)!;
    expect(p.verified_skills).toEqual(["Go", "Redis"]);
    expect(p.never_claim_skills).toEqual(["Kubernetes", "React"]); // the seed profile never-claims Kubernetes
  });

  it("guardSeed: an alias naming another profile skill neither decides the status nor stays an alias", () => {
    const src = sources();
    src.profile = { ...src.profile, verified_skills: ["Docker"], never_claim_skills: ["Docker Swarm"] };
    const seed = guardSeed({ tags: [{ name: "Docker", aliases: ["Docker Compose", "Docker Swarm"], category: "infra" }], stories: [] }, src);
    expect(seed.tags.map((t) => [t.name, t.aliases, t.status])).toEqual([
      ["Docker", ["Docker Compose"], "yes"],
      ["Docker Swarm", [], "no"],
    ]);
  });

  it("withKbSkills: an alias never removes an entry from the human's lists", () => {
    const p = { verified_skills: ["Docker"], never_claim_skills: ["Docker Swarm"] };
    expect(withKbSkills(p, [{ name: "Docker", aliases: ["Docker Swarm"], status: "yes" as const }])).toEqual(p);
    expect(withKbSkills(p, [{ name: "Swarm", aliases: ["Docker"], status: "no" as const }]).verified_skills).toEqual(["Docker"]);
  });

  it("applySeed: an LLM re-run, a tag turned `no` and a deleted story do not re-import stories", () => {
    const { store, uid } = setup();
    store.saveProfile(uid, { ...defaultProfile(), verified_skills: ["Go"], never_claim_skills: [] });
    const seed = { tags: [], stories: [draft()] };
    expect(applySeed(store, uid, seed).storiesAdded).toBe(1);
    // same story reworded by another LLM pass
    expect(applySeed(store, uid, { tags: [], stories: [draft({ did: "Сделал кэш ответов на Redis для провайдеров." })] })).toMatchObject({ storiesAdded: 0, storiesSkipped: 1 });
    // Redis turned `no` between runs of the same file
    store.upsertKbTag(uid, { name: "Redis", status: "no" });
    expect(applySeed(store, uid, seed)).toMatchObject({ storiesAdded: 0, storiesSkipped: 1 });
    // the human deleted the seeded story: it stays deleted
    store.deleteKbStory(store.listKbStories(uid)[0]!.id);
    expect(applySeed(store, uid, seed)).toMatchObject({ storiesAdded: 0, storiesSkipped: 1 });
    expect(store.listKbStories(uid)).toHaveLength(0);
  });

  it("kb_seed output: a story without a title or a garbled tag does not throw the pass away", () => {
    const out = KbSeedSchema.parse({ tags: [{ name: null }, { name: "Go", aliases: [] }], stories: [{ title: null, did: "Сделал кэш." }, 42] });
    expect(out.tags.map((t) => t.name)).toEqual(["", "Go"]);
    expect(out.stories.map((s) => s.did)).toEqual(["Сделал кэш.", ""]);
    const seed = guardSeed(out, sources());
    expect(seed.stories).toHaveLength(1);
    expect(seed.tags.some((t) => !t.name)).toBe(false);
  });

  it("seed prompt carries the rules, the CVs and the verified list", () => {
    const prompt = seedPrompt(sources());
    expect(prompt).toContain("## Правила");
    expect(prompt).toContain("НИКОГДА не упоминай как свой опыт: Kubernetes");
    expect(prompt).toContain("Интегрировал 198 AI-моделей");
    expect(prompt).toContain("verified_skills): Go, Redis, React");
    expect(prompt).not.toMatch(/\{\{/);
  });

  it("storyHash ignores case, spacing and tag order", () => {
    expect(storyHash(draft({ title: "кэш  на redis", tags: ["Go", "Redis"] }))).toBe(storyHash(draft()));
    expect(storyHash(draft({ did: "Другое." }))).not.toBe(storyHash(draft()));
  });
});

describe("ingest", () => {
  it("keeps the human's numbers, drops invented ones, always links the asked tag", async () => {
    const llm = new FakeLLM();
    llm.onJson = () => ({
      stories: [
        { title: "Тесты на Vitest", company: "Яндекс", period: "2023", context: "Фронтенд.", did: "Писал компонентные тесты на Vitest. Покрыл 90% кода.", result: "Покрытие выросло до 60%.", tags: ["React"] },
        { title: "Пусто", did: "Ускорил CI в 3 раза.", tags: [] },
      ],
    });
    const out = await ingestKb(llm, { tag: "Vitest", text: "В Яндексе писал компонентные тесты на Vitest, покрытие подняли до 60%", companies: ["Яндекс, 2022-2024"] });
    expect(llm.calls[0]!.args[0]).toBe("kb_ingest");
    expect(String(llm.calls[0]!.args[2])).toContain("покрытие подняли до 60%");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ did: "Писал компонентные тесты на Vitest.", result: "Покрытие выросло до 60%.", period: "", tags: ["Vitest", "React"] });

    expect(await ingestKb(llm, { tag: "Vitest", text: "  " })).toEqual([]);

    const { store, uid } = setup();
    store.saveProfile(uid, defaultProfile());
    const saved = saveIngested(store, uid, "Vitest", out);
    expect(saved[0]).toMatchObject({ source: "telegram", confirmed: true });
    expect(store.listKbTags(uid).find((t) => t.name === "Vitest")!.status).toBe("yes");
    expect(store.listKbTags(uid).find((t) => t.name === "React")!.status).toBe("unknown");
    expect(store.getProfile(uid)!.verified_skills).toEqual(["Vitest"]);
  });

  it("stripInventedNumbers treats 2,5 and 2.5 alike", () => {
    expect(stripInventedNumbers("Опыт 2,5 года. Ускорил в 10 раз.", allowedNumbers("опыт 2.5 года"))).toBe("Опыт 2,5 года.");
  });

  it("stripInventedNumbers: a number needs its unit in the sources; quantity words need to be there verbatim", () => {
    const allowed = allowedNumbers("Python 3, опыт 3 года. Обслуживал 30 серверов. Go 1.18, 2022-2024. Ускорили сборку вдвое.");
    const keep = ["Писал на Python 3.", "Обслуживал 30 серверов.", "Перешли на Go 1.18 в 2022 году.", "Сборка стала быстрее вдвое."];
    for (const s of keep) expect(stripInventedNumbers(s, allowed)).toBe(s);
    for (const s of ["Ускорил сборку в 3 раза.", "Снизил latency на 30%.", "Ускорил в два раза.", "Сотни тысяч пользователей.", "Выросло в десятки раз.", "Рост в разы."])
      expect(stripInventedNumbers(s, allowed)).toBe("");
  });
});

describe("profile sync", () => {
  it("yes -> verified, no -> never_claim, alias-aware, unknown untouched", () => {
    const p = { verified_skills: ["golang", "Vue", "Kafka"], never_claim_skills: ["React", "PHP"] };
    const tags = [
      { name: "Go", aliases: ["golang"], status: "yes" as const },
      { name: "React", aliases: [], status: "yes" as const },
      { name: "Kafka", aliases: [], status: "no" as const },
      { name: "PHP", aliases: [], status: "unknown" as const },
      { name: "Grafana", aliases: [], status: "yes" as const },
    ];
    expect(withKbSkills(p, tags)).toEqual({ verified_skills: ["golang", "Vue", "React", "Grafana"], never_claim_skills: ["PHP", "Kafka"] });

    const { store, uid } = setup();
    expect(syncProfileSkills(store, uid)).toBe(false); // no profile yet
    store.saveProfile(uid, { ...defaultProfile(), ...p });
    for (const t of tags) store.upsertKbTag(uid, t);
    expect(syncProfileSkills(store, uid)).toBe(true);
    expect(syncProfileSkills(store, uid)).toBe(false);
    expect(store.getProfile(uid)!.never_claim_skills).toEqual(["PHP", "Kafka"]);
  });
});
