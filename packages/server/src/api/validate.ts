import type { Context } from "hono";
import { z } from "zod";
import { Status } from "@sgz/shared";
import { badRequest } from "./errors.js";

export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("invalid JSON body");
  }
  return schema.parse(raw);
}

/** Like parseBody but an empty body parses as `{}` (for POSTs whose body is optional). */
export async function parseOptionalBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const text = (await c.req.text()).trim();
  if (!text) return schema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badRequest("invalid JSON body");
  }
  return schema.parse(raw);
}

export function intParam(raw: string | undefined, name: string): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 0) throw badRequest(`invalid ${name}`);
  return n;
}

export function pagination(c: Context): { page: number; pageSize: number } {
  const page = c.req.query("page") ? intParam(c.req.query("page"), "page") : 1;
  const pageSize = c.req.query("page_size") ? intParam(c.req.query("page_size"), "page_size") : 50;
  if (page < 1) throw badRequest("page must be >= 1");
  if (pageSize < 1 || pageSize > 200) throw badRequest("page_size must be 1..200");
  return { page, pageSize };
}

const STATUS_VALUES = Object.values(Status) as Status[];
export function statusList(csv: string | undefined): Status[] | undefined {
  if (!csv) return undefined;
  const out: Status[] = [];
  for (const s of csv.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!STATUS_VALUES.includes(s as Status)) throw badRequest(`unknown status: ${s}`);
    out.push(s as Status);
  }
  return out.length ? out : undefined;
}

const str = z.string().default("");
const strList = z.array(z.string()).default([]);

export const ProfileSchema = z.object({
  full_name: str,
  email: str,
  phone: str,
  telegram: str,
  city: str,
  citizenship: str,
  relocation: str,
  work_formats: strList,
  salary_from: z.number().int().min(0).default(0),
  salary_to: z.number().int().min(0).default(0),
  currency: str,
  experience: str,
  languages: strList,
  directions: strList,
  summary: str,
  verified_skills: strList,
  never_claim_skills: strList,
  hh_queries: strList,
  hh_area: str,
  exclude_words: strList,
  company_blacklist: strList,
  extra: z.record(z.string(), z.string()).default({}),
});

const limit = z.number().int().min(0).optional();
/** Accepts both snake_case (docs/api.md) and camelCase (shared model) keys. */
export const UserPatchSchema = z.object({
  name: z.string().min(1).optional(),
  tg_chat_id: z.string().optional(),
  tgChatId: z.string().optional(),
  daily_limit_hh: limit,
  dailyLimitHH: limit,
  daily_limit_career: limit,
  dailyLimitCareer: limit,
  active: z.boolean().optional(),
  allow_other_country: z.boolean().optional(),
  allowOtherCountry: z.boolean().optional(),
  pool_expand_per_day: limit,
  poolExpandPerDay: limit,
  opus_enabled: z.boolean().optional(),
  opusEnabled: z.boolean().optional(),
});

export const StartRunSchema = z.object({
  user: z.string().min(1),
  source: z.enum(["hh", "career", "all", "pool"]),
  dry_run: z.boolean().optional(),
  limit: z.number().int().min(0).optional(),
  stage: z.string().optional(),
});

export const ExpandSchema = z.object({ max: z.number().int().min(0).optional() });

export const ATS_KINDS = [
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "teamtailor",
  "smartrecruiters",
  "huntflow",
  "potok",
  "hh_hosted",
  "custom",
] as const;

const SiteProfileSchema = z
  .object({
    listing_url: z.string().optional(),
    jobs_json_url: z.string().optional(),
    ats_board_token: z.string().optional(),
    filters: z.array(z.string()).optional(),
    apply_mode: z.enum(["ats_api", "agent"]).optional(),
    apply_hints: z.string().optional(),
    discover_hints: z.string().optional(),
    notes: z.string().optional(),
    last_verified_at: z.string().optional(),
  })
  .default({});

/** Body of POST/PUT career-sites: docs name the fields adapter/base_url/config; model names ats/baseUrl/profile. */
export const CareerSiteSchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  base_url: z.string().url().optional(),
  baseUrl: z.string().url().optional(),
  adapter: z.enum(ATS_KINDS).optional(),
  ats: z.enum(ATS_KINDS).optional(),
  config: SiteProfileSchema.optional(),
  profile: SiteProfileSchema.optional(),
  enabled: z.boolean().optional(),
});

export const SETTING_KEYS = ["schedule_at", "schedule_jitter_min", "dedup_window_days", "tz"] as const;
const numish = z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]).transform(String);
export const SettingsSchema = z
  .object({
    schedule_at: z.union([z.literal(""), z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM")]),
    schedule_jitter_min: numish,
    dedup_window_days: numish,
    tz: z.string().min(1).refine((tz) => {
      try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
    }, "invalid timezone"),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "no settings given");
