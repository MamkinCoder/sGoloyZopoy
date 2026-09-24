// zod 4 schemas for every prompt output. Tolerant on optional fields, strict on shape.
import { z } from "zod";

export const DecisionSchema = z.object({
  vacancy_id: z.coerce.number().int(),
  apply: z.boolean(),
  reason: z.string().default(""),
  resume_id: z.string().default(""),
  cover_letter: z.string().default(""),
  direction: z.string().default(""),
  seniority: z.string().default(""),
  red_flags: z.array(z.string()).default([]),
  resume_fit: z.enum(["good", "poor"]).catch("good"),
  tailored: z.object({ title: z.string(), about: z.string().default(""), key_skills: z.array(z.string()).default([]) }).optional().catch(undefined),
  // No fake default: a missing or garbled score stays undefined and the UI shows no chip.
  fit_score: z.number().min(0).max(100).optional().catch(undefined),
  fit_reason: z.string().optional().catch(undefined),
});
export const DecisionsSchema = z.array(DecisionSchema);

export const AnswerSchema = z.object({
  idx: z.coerce.number().int(),
  text: z.string().optional(),
  option_idx: z.coerce.number().int().optional(),
  option_idxs: z.array(z.coerce.number().int()).optional(),
});
export const AnswersSchema = z.array(AnswerSchema);

export const ChatReplySchema = z.object({
  // A missing reply usually means the model returned an unrelated object;
  // keep that case retryable instead of silently producing an empty answer.
  reply: z.string(),
  needs_human: z.boolean().default(false),
  reason: z.string().default(""),
  unknown_skills: z.array(z.string()).default([]),
  interview_at: z.string().nullable().default(null),
});

/** triage_chat: what an employer turn needs before a reply is written (agent chats.triage). */
export const ChatTriageSchema = z.object({
  kind: z.enum(["question", "scheduling", "test_task", "rejection", "bot_survey", "ack_only"]).catch("question"),
  topics: z.array(z.string()).default([]),
});

export const InterviewPrepSchema = z.object({
  questions: z.array(z.string()).default([]),
  stories: z.array(z.object({ skill: z.string(), prompt: z.string() })).default([]),
  gaps: z.array(z.string()).default([]),
  ask_them: z.array(z.string()).default([]),
});

/** interview_study: 10-20 topics the interviewer will likely ask about; tolerant per field, strict on topic. */
export const StudyItemSchema = z.object({
  topic: z.string(),
  why: z.string().default(""),
  level: z.enum(["must", "likely", "nice"]).catch("likely"),
  gap: z.boolean().catch(false),
  study: z.string().default(""),
});
export const StudyChecklistSchema = z.object({ checklist: z.array(StudyItemSchema) });

export const ResumeSummarySchema = z.object({
  direction: z.string(),
  seniority: z.string().default(""),
  key_skills: z.array(z.string()).default([]),
  one_line: z.string().default(""),
});

export const PoolVariantSchema = z.object({
  title: z.string(),
  about: z.string().default(""),
  key_skills: z.array(z.string()).default([]),
  based_on_resume_id: z.string().default(""),
  direction: z.string().default(""),
});
export const PoolVariantsSchema = z.array(PoolVariantSchema);

export const CVSchema = z.object({
  title: z.string(),
  name: z.string(),
  contacts: z.object({
    email: z.string().default(""),
    phone: z.string().default(""),
    telegram: z.string().default(""),
    github: z.string().default(""),
    city: z.string().default(""),
  }),
  about: z.string().default(""),
  skills: z.array(z.object({ name: z.string(), items: z.array(z.string()) })).default([]),
  jobs: z
    .array(
      z.object({
        company: z.string(),
        role: z.string(),
        period: z.string(),
        location: z.string().default(""),
        summary: z.string().default(""),
        bullets: z.array(z.string()).default([]),
        stack: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  education: z
    .array(z.object({ institution: z.string(), degree: z.string().default(""), period: z.string().default(""), note: z.string().default("") }))
    .default([]),
});

export const TailorSchema = z.object({ cv: CVSchema, changes: z.array(z.string()).default([]) });

export const CoverLetterSchema = z.object({ cover_letter: z.string() });

/** Accepts `[...]`, `{items:[...]}`, `{decisions:[...]}` etc. — models love wrapping arrays. */
export function unwrapArray(v: unknown): unknown {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const vals = Object.values(v as Record<string, unknown>);
    if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
    for (const key of ["items", "decisions", "answers", "variants", "results"]) {
      const inner = (v as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return v;
}

/** learn_letters: style lessons from invited vs. not invited letters. */
export const LessonsSchema = z.object({ lessons: z.array(z.string()).default([]) });
/** Mock interview in Telegram (runner/mock.ts): feedback on one answer, then the closing summary. */
export const MockFeedbackSchema = z.object({ feedback: z.string().min(1), follow_up: z.string().nullable().catch(null).default(null) });
export const MockSummarySchema = z.object({ tighten: z.array(z.string()).default([]) });
