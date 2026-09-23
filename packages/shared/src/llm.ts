// LLM contract. Workstream D implements over `claude -p` (Claude Code headless, subscription).
import type { StagehandLLM } from "./browser.js";
import type { Answer, CV, ChatMessage, Decision, HHResume, InterviewPrep, Profile, Question, ResumeSummary, Vacancy } from "./model.js";

export type Tier = "fast" | "write" | "tailor"; // haiku | sonnet | opus

export interface DecideInput {
  profile: Profile;
  resumes: HHResume[];
  vacancies: Vacancy[]; // batched ≤10 per call by the implementation
  /** Advisory reply history per companyKey(v.company), only employers past the min-N gate. */
  companyHistory?: Record<string, string>;
  /** Advisory conversion lines per pool resume (tie-breaker within one direction). */
  resumeStats?: string[];
  /** Letter style lessons learned from past outcomes (settings letter_lessons:<userId>). */
  lessons?: string[];
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
  /** Skills the employer asked about that the profile neither has nor rules out: ask the human first. */
  unknown_skills?: string[];
  /** Interview/call time the employer set or confirmed (UTC ISO), null when none. */
  interview_at?: string | null;
}

export interface LLMClient {
  decide(input: DecideInput): Promise<Decision[]>;
  answerQuestionnaire(profile: Profile, vacancy: Vacancy | null, qs: Question[]): Promise<Answer[]>;
  /** `choices`: quick-reply buttons on the employer's last message; the reply must be exactly one of them. */
  answerChat(profile: Profile, vacancy: Vacancy | null, history: ChatMessage[], choices?: string[]): Promise<ChatReply>;
  summarizeResume(resumeText: string): Promise<ResumeSummary>;
  proposePoolVariants(profile: Profile, existing: HHResume[], max: number): Promise<PoolVariant[]>;
  tailorCV(profile: Profile, base: CV, vacancy: Vacancy, tier?: Tier): Promise<{ cv: CV; changes: string[] }>;
  coverLetterCareer(profile: Profile, cv: CV, vacancy: Vacancy, lessons?: string[]): Promise<string>;
  /** Prep brief for the seeker on an invitation; `invitation` is the employer's last message. */
  interviewPrep(profile: Profile, vacancy: Vacancy, invitation: string): Promise<InterviewPrep>;
  /** Free-form JSON task used by the browser layer's agent flows (career onboarding etc.). */
  json<T>(task: string, tier: Tier, prompt: string, schemaDescription: string): Promise<T>;
  /** Adapter for Stagehand's `model: { generate }`. */
  stagehand(): StagehandLLM;
  /** Tag subsequent calls with a run id for llm_calls logging. */
  withRun(runId: number | null): LLMClient;
}
