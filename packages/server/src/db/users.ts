import type { Profile, Store, User } from "@sgz/shared";
import { normalizeProfile } from "../config/profile.js";
import { bool, num, str, toJson, type Row, type Sql, nowISO, json } from "./sql.js";

export const mapUser = (r: Row): User => ({
  id: num(r.id),
  slug: str(r.slug),
  name: str(r.name),
  tgChatId: str(r.tg_chat_id),
  dailyLimitHH: num(r.daily_limit_hh),
  dailyLimitCareer: num(r.daily_limit_career),
  active: bool(r.active),
  allowOtherCountry: bool(r.allow_other_country),
  poolExpandPerDay: num(r.pool_expand_per_day),
  opusEnabled: bool(r.opus_enabled),
});

type UsersRepo = Pick<Store, "upsertUser" | "getUserBySlug" | "listUsers" | "getProfile" | "saveProfile">;

export function usersRepo(s: Sql): UsersRepo {
  const byId = (id: number): User | null => {
    const r = s.get("SELECT * FROM users WHERE id = ?", id);
    return r ? mapUser(r) : null;
  };
  return {
    upsertUser(u) {
      const vals = [
        u.slug,
        u.name,
        u.tgChatId,
        u.dailyLimitHH,
        u.dailyLimitCareer,
        u.active,
        u.allowOtherCountry,
        u.poolExpandPerDay,
        u.opusEnabled,
      ];
      if (u.id !== undefined) {
        const { changes } = s.run(
          `UPDATE users SET slug=?, name=?, tg_chat_id=?, daily_limit_hh=?, daily_limit_career=?, active=?,
             allow_other_country=?, pool_expand_per_day=?, opus_enabled=? WHERE id=?`,
          ...vals,
          u.id,
        );
        if (!changes) throw new Error(`user ${u.id} not found`);
        return byId(u.id) as User;
      }
      const r = s.get(
        `INSERT INTO users (slug, name, tg_chat_id, daily_limit_hh, daily_limit_career, active,
           allow_other_country, pool_expand_per_day, opus_enabled)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(slug) DO UPDATE SET name=excluded.name, tg_chat_id=excluded.tg_chat_id,
           daily_limit_hh=excluded.daily_limit_hh, daily_limit_career=excluded.daily_limit_career,
           active=excluded.active, allow_other_country=excluded.allow_other_country,
           pool_expand_per_day=excluded.pool_expand_per_day, opus_enabled=excluded.opus_enabled
         RETURNING *`,
        ...vals,
      );
      return mapUser(r as Row);
    },
    getUserBySlug(slug) {
      const r = s.get("SELECT * FROM users WHERE slug = ?", slug);
      return r ? mapUser(r) : null;
    },
    listUsers(onlyActive = false) {
      const rows = onlyActive
        ? s.all("SELECT * FROM users WHERE active = 1 ORDER BY id")
        : s.all("SELECT * FROM users ORDER BY id");
      return rows.map(mapUser);
    },
    getProfile(userId) {
      const r = s.get("SELECT facts_json FROM user_profiles WHERE user_id = ?", userId);
      if (!r) return null;
      const raw = json<Record<string, unknown> | null>(r.facts_json, null);
      if (!raw || Object.keys(raw).length === 0) return null;
      return normalizeProfile(raw);
    },
    saveProfile(userId, p: Profile) {
      s.run(
        `INSERT INTO user_profiles (user_id, facts_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET facts_json=excluded.facts_json, updated_at=excluded.updated_at`,
        userId,
        toJson(normalizeProfile(p)),
        nowISO(),
      );
    },
  };
}

const DEFAULT_USERS: Omit<User, "id">[] = [
  { slug: "yaroslav", name: "Ярослав" },
  { slug: "alina", name: "Алина" },
].map((u) => ({
  ...u,
  tgChatId: "",
  dailyLimitHH: 25,
  dailyLimitCareer: 10,
  active: true,
  allowOtherCountry: true,
  poolExpandPerDay: 2,
  opusEnabled: false,
}));

/** Defaults for a user created by `sgz db import-profile` (first-time setup of a new person). */
export const newUserDefaults = (slug: string, name: string): Omit<User, "id"> => ({ ...DEFAULT_USERS[0]!, slug, name });

/** Creates the two household users when the users table is empty. Returns the created users. */
export function seedDefaultUsers(store: Pick<Store, "listUsers" | "upsertUser">): User[] {
  if (store.listUsers().length > 0) return [];
  return DEFAULT_USERS.map((u) => store.upsertUser(u));
}
