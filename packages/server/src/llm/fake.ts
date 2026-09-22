// Deterministic LLMClient for other workstreams' tests. Override any `on*` field per test.
import type {
  Answer,
  CV,
  ChatMessage,
  ChatReply,
  DecideInput,
  Decision,
  HHResume,
  LLMClient,
  PoolVariant,
  Profile,
  Question,
  ResumeSummary,
  StagehandLLM,
  Tier,
  Vacancy,
} from "@sgz/shared";

export interface FakeCall {
  method: string;
  runId: number | null;
  args: unknown[];
}

export class FakeLLM implements LLMClient {
  runId: number | null = null;
  /** Shared across withRun() copies. */
  calls: FakeCall[] = [];

  onDecide: (input: DecideInput) => Decision[] = (input) =>
    input.vacancies.map((v) => ({
      vacancy_id: v.id,
      apply: true,
      reason: "fake: подходит",
      resume_id: input.resumes[0]?.hhResumeId ?? "",
      cover_letter: `Здравствуйте. Откликаюсь на вакансию ${v.title}. Опыт совпадает по основному стеку. Готов обсудить детали.`,
      direction: input.resumes[0]?.direction ?? "",
      seniority: "middle",
      red_flags: [],
    }));

  onAnswerQuestionnaire: (profile: Profile, vacancy: Vacancy | null, qs: Question[]) => Answer[] = (_p, _v, qs) =>
    qs.map((q) => {
      if (q.kind === "radio" || q.kind === "select") return { idx: q.idx, option_idx: 0 };
      if (q.kind === "checkbox") return { idx: q.idx, option_idxs: [0] };
      if (q.kind === "file") return { idx: q.idx, text: "" };
      return { idx: q.idx, text: "fake answer" };
    });

  onAnswerChat: (profile: Profile, vacancy: Vacancy | null, history: ChatMessage[]) => ChatReply = () => ({
    reply: "Да, готов обсудить детали.",
    needs_human: false,
    reason: "fake",
  });

  onSummarizeResume: (text: string) => ResumeSummary = () => ({
    direction: "go-backend",
    seniority: "middle",
    key_skills: ["Go", "Redis", "Docker"],
    one_line: "Backend-разработчик, Go, 2.5 года",
  });

  onProposePoolVariants: (profile: Profile, existing: HHResume[], max: number) => PoolVariant[] = (p, existing, max) =>
    p.directions
      .filter((d) => !existing.some((r) => r.direction === d))
      .slice(0, max)
      .map((d) => ({
        title: `Разработчик (${d})`,
        about: `Разработчик направления ${d}. ${p.summary.trim()}`,
        key_skills: p.verified_skills.slice(0, 8),
        based_on_resume_id: existing[0]?.hhResumeId ?? "",
        direction: d,
      }));

  onTailorCV: (profile: Profile, base: CV, vacancy: Vacancy, tier?: Tier) => { cv: CV; changes: string[] } = (_p, base, v) => ({
    cv: { ...base, title: v.title },
    changes: [`title -> ${v.title}`],
  });

  onCoverLetterCareer: (profile: Profile, cv: CV, vacancy: Vacancy) => string = (_p, _cv, v) =>
    `Здравствуйте. Откликаюсь на позицию ${v.title} в ${v.company}. Опыт совпадает по стеку. Готов обсудить детали.`;

  onJson: (task: string, tier: Tier, prompt: string, schemaDescription: string) => unknown = () => ({});

  onStagehand: StagehandLLM["generate"] = async (p) => {
    const last = p.messages[p.messages.length - 1]?.content ?? "";
    return p.responseFormat?.type === "json_schema" ? { text: "{}", structured: {} } : { text: `fake: ${last.slice(0, 40)}` };
  };

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, runId: this.runId, args });
  }

  async decide(input: DecideInput): Promise<Decision[]> {
    this.record("decide", [input]);
    return this.onDecide(input);
  }
  async answerQuestionnaire(profile: Profile, vacancy: Vacancy | null, qs: Question[]): Promise<Answer[]> {
    this.record("answerQuestionnaire", [profile, vacancy, qs]);
    return this.onAnswerQuestionnaire(profile, vacancy, qs);
  }
  async answerChat(profile: Profile, vacancy: Vacancy | null, history: ChatMessage[]): Promise<ChatReply> {
    this.record("answerChat", [profile, vacancy, history]);
    return this.onAnswerChat(profile, vacancy, history);
  }
  async summarizeResume(resumeText: string): Promise<ResumeSummary> {
    this.record("summarizeResume", [resumeText]);
    return this.onSummarizeResume(resumeText);
  }
  async proposePoolVariants(profile: Profile, existing: HHResume[], max: number): Promise<PoolVariant[]> {
    this.record("proposePoolVariants", [profile, existing, max]);
    return this.onProposePoolVariants(profile, existing, max);
  }
  async tailorCV(profile: Profile, base: CV, vacancy: Vacancy, tier?: Tier): Promise<{ cv: CV; changes: string[] }> {
    this.record("tailorCV", [profile, base, vacancy, tier]);
    return this.onTailorCV(profile, base, vacancy, tier);
  }
  async coverLetterCareer(profile: Profile, cv: CV, vacancy: Vacancy): Promise<string> {
    this.record("coverLetterCareer", [profile, cv, vacancy]);
    return this.onCoverLetterCareer(profile, cv, vacancy);
  }
  async json<T>(task: string, tier: Tier, prompt: string, schemaDescription: string): Promise<T> {
    this.record("json", [task, tier, prompt, schemaDescription]);
    return this.onJson(task, tier, prompt, schemaDescription) as T;
  }
  stagehand(): StagehandLLM {
    return { generate: (p) => this.onStagehand(p) };
  }
  withRun(runId: number | null): LLMClient {
    const copy: FakeLLM = Object.assign(Object.create(Object.getPrototypeOf(this) as object), this);
    copy.runId = runId;
    return copy;
  }
}
