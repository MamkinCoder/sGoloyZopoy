import { Hono } from "hono";
import type { ProfileDTO, StatsDTO, User } from "@sgz/shared";
import type { ApiDeps } from "../deps.js";
import { badRequest } from "../errors.js";
import { parseBody, ProfileSchema, UserPatchSchema } from "../validate.js";
import { userOr404 } from "./common.js";
import { weeklyRetro } from "../../notify/retro.js";

const EMPTY_PROFILE: ProfileDTO = ProfileSchema.parse({});

function sinceFor(range: string | undefined): string | null {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  switch (range ?? "all") {
    case "today": {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "7d":
      return new Date(now - 7 * day).toISOString();
    case "30d":
      return new Date(now - 30 * day).toISOString();
    case "all":
      return null;
    default:
      throw badRequest("range must be today|7d|30d|all");
  }
}

export function userRoutes({ store }: ApiDeps): Hono {
  const r = new Hono();

  r.get("/users", (c) => c.json(store.listUsers()));
  r.get("/users/:slug", (c) => c.json(userOr404(store, c.req.param("slug"))));

  r.put("/users/:slug", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const p = await parseBody(c, UserPatchSchema);
    const next: User = {
      ...u,
      name: p.name ?? u.name,
      tgChatId: p.tg_chat_id ?? p.tgChatId ?? u.tgChatId,
      dailyLimitHH: p.daily_limit_hh ?? p.dailyLimitHH ?? u.dailyLimitHH,
      dailyLimitCareer: p.daily_limit_career ?? p.dailyLimitCareer ?? u.dailyLimitCareer,
      active: p.active ?? u.active,
      allowOtherCountry: p.allow_other_country ?? p.allowOtherCountry ?? u.allowOtherCountry,
      poolExpandPerDay: p.pool_expand_per_day ?? p.poolExpandPerDay ?? u.poolExpandPerDay,
      opusEnabled: p.opus_enabled ?? p.opusEnabled ?? u.opusEnabled,
    };
    return c.json(store.upsertUser(next));
  });

  r.get("/users/:slug/profile", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    return c.json(store.getProfile(u.id) ?? EMPTY_PROFILE);
  });

  r.put("/users/:slug/profile", async (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const profile = await parseBody(c, ProfileSchema);
    store.saveProfile(u.id, profile);
    return c.json(profile);
  });

  r.get("/users/:slug/stats", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    const s = store.userStats(u.id, sinceFor(c.req.query("range")));
    const dto: StatsDTO = {
      sent: s.sent,
      skipped: s.skipped,
      failed: s.failed,
      by_status: s.byStatus,
      invitations: s.invitations,
      rejections: s.rejections,
      chat_replies: s.chatReplies,
      runs_count: s.runsCount,
    };
    return c.json(dto);
  });

  r.get("/users/:slug/analytics", (c) => {
    const u = userOr404(store, c.req.param("slug"));
    return c.json(store.userAnalytics(u.id, sinceFor(c.req.query("range"))));
  });

  r.get("/users/:slug/retro", (c) => c.json(weeklyRetro(store, userOr404(store, c.req.param("slug")), new Date())));

  return r;
}
