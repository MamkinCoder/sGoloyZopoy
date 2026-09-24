// LLM contract. Workstream D implements over `claude -p` (Claude Code headless, subscription).
import type { ChatTurnKind } from "./agent.js";
import type { StagehandLLM } from "./browser.js";
import type { KbBrief } from "./kb.js";
import type { Answer, CV, ChatMessage, Decision, HHResume, InterviewPrep, Profile, Question, ResumeSummary, StudyItem, Vacancy } from "./model.js";

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
  /** Knowledge-base block for one decide batch: letters and tailored resume copies draw on it. */
  kb?: (vacancies: Vacancy[]) => KbBrief | undefined;
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

/** triageChat: the kind of an employer turn and the skills it asks about (canonical names). */
export interface ChatTriage {
  kind: ChatTurnKind;
  topics: string[];
}

export interface LLMClient {
  decide(input: DecideInput): Promise<Decision[]>;
  /** `kb` (optional everywhere below): the knowledge-base block for this text; its `no` tags join never_claim. */
  answerQuestionnaire(profile: Profile, vacancy: Vacancy | null, qs: Question[], kb?: KbBrief): Promise<Answer[]>;
  /** `choices`: quick-reply buttons on the employer's last message; the reply must be exactly one of them. */
  /** `kb`: the knowledge-base block for the asked topics (kb/context.ts renderKb), the only material about experience. */
  answerChat(profile: Profile, vacancy: Vacancy | null, history: ChatMessage[], choices?: string[], kb?: KbBrief): Promise<ChatReply>;
  /** Decides what an employer turn needs (no reply text): kind + asked-about skills. `fresh` = the new messages. */
  triageChat(profile: Profile, history: ChatMessage[], fresh: ChatMessage[]): Promise<ChatTriage>;
  summarizeResume(resumeText: string): Promise<ResumeSummary>;
  proposePoolVariants(profile: Profile, existing: HHResume[], max: number): Promise<PoolVariant[]>;
  tailorCV(profile: Profile, base: CV, vacancy: Vacancy, tier?: Tier, kb?: KbBrief): Promise<{ cv: CV; changes: string[] }>;
  coverLetterCareer(profile: Profile, cv: CV, vacancy: Vacancy, lessons?: string[], kb?: KbBrief): Promise<string>;
  /** Rewrites a letter to fit a form's character limit (`max`); the result is at most `max` chars. */
  shortenLetter(profile: Profile, letter: string, max: number): Promise<string>;
  /** Prep brief for the seeker on an invitation; `invitation` is the employer's last message. */
  interviewPrep(profile: Profile, vacancy: Vacancy, invitation: string, kb?: KbBrief): Promise<InterviewPrep>;
  /** Interview study checklist (10-20 topics) for the vacancy, on a button press; `prep` is the thread's brief. */
  interviewStudy(profile: Profile, vacancy: Vacancy, prep: InterviewPrep | null, kb?: KbBrief): Promise<StudyItem[]>;
  /** Free-form JSON task used by the browser layer's agent flows (career onboarding etc.). */
  json<T>(task: string, tier: Tier, prompt: string, schemaDescription: string): Promise<T>;
  /** Adapter for Stagehand's `model: { generate }`. */
  stagehand(): StagehandLLM;
  /** Tag subsequent calls with a run id for llm_calls logging. */
  withRun(runId: number | null): LLMClient;
}
