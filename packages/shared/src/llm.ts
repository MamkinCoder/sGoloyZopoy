// LLM contract. Workstream D implements over `claude -p` (Claude Code headless, subscription).
import type { StagehandLLM } from "./browser.js";
import type { Answer, CV, ChatMessage, Decision, HHResume, Profile, Question, ResumeSummary, Vacancy } from "./model.js";

export type Tier = "fast" | "write" | "tailor"; // haiku | sonnet | opus

export interface DecideInput {
  profile: Profile;
  resumes: HHResume[];
  vacancies: Vacancy[]; // batched ≤10 per call by the implementation
}

export interface PoolVariant {
  title: string;
  about: string;
  key_skills: string[];
  based_on_resume_id: string;
  direction: string;
}

export interface ChatReply {
  reply: string; // "" → do not send
  needs_human: boolean;
  reason: string;
}

export interface LLMClient {
  decide(input: DecideInput): Promise<Decision[]>;
  answerQuestionnaire(profile: Profile, vacancy: Vacancy | null, qs: Question[]): Promise<Answer[]>;
  answerChat(profile: Profile, vacancy: Vacancy | null, history: ChatMessage[]): Promise<ChatReply>;
  summarizeResume(resumeText: string): Promise<ResumeSummary>;
  proposePoolVariants(profile: Profile, existing: HHResume[], max: number): Promise<PoolVariant[]>;
  tailorCV(profile: Profile, base: CV, vacancy: Vacancy, tier?: Tier): Promise<{ cv: CV; changes: string[] }>;
  coverLetterCareer(profile: Profile, cv: CV, vacancy: Vacancy): Promise<string>;
  /** Free-form JSON task used by the browser layer's agent flows (career onboarding etc.). */
  json<T>(task: string, tier: Tier, prompt: string, schemaDescription: string): Promise<T>;
  /** Adapter for Stagehand's `model: { generate }`. */
  stagehand(): StagehandLLM;
  /** Tag subsequent calls with a run id for llm_calls logging. */
  withRun(runId: number | null): LLMClient;
}
