import type { Context } from "hono";
import type { ApplicationDTO, ApplicationRow, Run, RunDTO, Store, User } from "@sgz/shared";
import { notFound } from "../errors.js";
import { intParam } from "../validate.js";

export function userOr404(store: Store, slug: string | undefined): User {
  const u = slug ? store.getUserBySlug(slug) : null;
  if (!u) throw notFound(`user not found: ${slug}`);
  return u;
}

export const idParam = (c: Context, name = "id"): number => intParam(c.req.param(name), name);

export const toApplicationDTO = (r: ApplicationRow): ApplicationDTO => ({
  application: r.application,
  vacancy: r.vacancy,
  resume_title: r.resumeTitle,
});

export function toRunDTO(store: Store, r: Run, slugCache?: Map<number, string | null>): RunDTO {
  let slug: string | null = null;
  if (r.userId !== null) {
    if (slugCache?.has(r.userId)) slug = slugCache.get(r.userId) ?? null;
    else {
      slug = store.listUsers().find((u) => u.id === r.userId)?.slug ?? null;
      slugCache?.set(r.userId, slug);
    }
  }
  return { ...r, user_slug: slug };
}
