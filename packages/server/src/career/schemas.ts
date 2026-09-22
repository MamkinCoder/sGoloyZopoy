import { z } from "zod";

export const jobListSchema = z.object({
  jobs: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      location: z.string().optional(),
    }),
  ),
});
export type JobList = z.infer<typeof jobListSchema>;

export const vacancyPageSchema = z.object({
  title: z.string(),
  company: z.string().optional(),
  description: z.string(),
  location: z.string().optional(),
  salary: z.string().optional(),
  work_format: z.string().optional(),
});

export const questionsSchema = z.object({
  questions: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(["radio", "checkbox", "text", "select", "number", "file"]),
      options: z.array(z.string()).optional(),
      required: z.boolean(),
    }),
  ),
});

export const confirmSchema = z.object({
  submitted: z.boolean(),
  message: z.string(),
});

/** What the site_onboard prompt must return (loose: the LLM may omit fields). */
export const onboardAnswerSchema = z.object({
  listing_url: z.string().optional().nullable(),
  discover_hints: z.string().optional().nullable(),
  apply_hints: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});
export type OnboardAnswer = z.infer<typeof onboardAnswerSchema>;

export const ONBOARD_SCHEMA_DESCRIPTION =
  '{"listing_url": "absolute URL of the page listing open vacancies (this page if it already lists them)", ' +
  '"discover_hints": "≤400 chars: where the job cards are, how to paginate / load more, which filters matter", ' +
  '"apply_hints": "≤400 chars: how applying works (button label, inline form vs external ATS, required fields)", ' +
  '"notes": "≤300 chars: anything else useful"}';
