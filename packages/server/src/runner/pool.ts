// hh resume pool: sync (titles + LLM summaries), expand (LLM variants → duplicateResume).
import type { HHResume, User } from "@sgz/shared";
import type { RunContext } from "./context.js";
import { dayInTz } from "../scheduler/tz.js";
import type { UserRun } from "./user.js";
import { errMessage } from "./util.js";

const SYNC_TTL_MS = 7 * 86_400_000;
export const syncKey = (slug: string) => `resumes_synced_at:${slug}`;

export function syncIsStale(ctx: RunContext, user: User): boolean {
  const at = ctx.store.getSetting(syncKey(user.slug));
  if (!at) return true;
  const t = Date.parse(at);
  return !Number.isFinite(t) || ctx.now().getTime() - t > SYNC_TTL_MS;
}

export async function syncPool(ctx: RunContext, u: UserRun): Promise<HHResume[]> {
  const { user, stats } = u;
  const s = await ctx.browser.openHH(user);
  const remote = await ctx.hh.syncResumes(s);
  ctx.log.info("pool", `sync: ${remote.length} resumes on hh`, { count: remote.length });
  const nowISO = ctx.now().toISOString();
  const pending: { row: HHResume; text: string }[] = [];
  for (const r of remote) {
    ctx.checkAbort();
    const existing = ctx.store.getHHResumeByHHId(r.hhResumeId);
    const changed = !existing || existing.title !== r.title || !existing.summary;
    const row = ctx.store.upsertHHResume({
      ...r,
      id: existing?.id,
      userId: user.id,
      direction: existing?.direction ?? "",
      summary: existing?.summary ?? null,
      isGenerated: existing?.isGenerated ?? false,
      syncedAt: nowISO,
    });
    if (changed) {
      try {
        pending.push({ row, text: await ctx.hh.resumeText(s, r.url) });
      } catch (e) {
        ctx.log.warn("pool", `${r.title}: resume text failed: ${errMessage(e)}`);
      }
      await ctx.throttle.afterRead();
    }
  }
  if (pending.length) {
    await ctx.browser.close();
    await ctx.memoryGuard("pool");
    for (const p of pending) {
      ctx.checkAbort();
      try {
        const summary = await ctx.llm.summarizeResume(p.text);
        stats.llmCall();
        ctx.store.upsertHHResume({ ...p.row, summary, direction: summary.direction || p.row.direction });
        ctx.log.info("pool", `${p.row.title}: ${summary.direction} / ${summary.seniority}`);
      } catch (e) {
        ctx.log.warn("pool", `${p.row.title}: summarize failed: ${errMessage(e)}`);
      }
    }
  }
  ctx.store.setSetting(syncKey(user.slug), nowISO);
  const pool = ctx.store.listHHResumes(user.id);
  ctx.log.info("pool", `sync done: ${pool.length} in pool, ${pending.length} summarized`, { pool: pool.length, summarized: pending.length });
  return pool;
}

export async function expandPool(ctx: RunContext, u: UserRun, pool: HHResume[]): Promise<void> {
  const { user, profile, stats } = u;
  const s = await ctx.browser.openHH(user);
  const cap = await ctx.hh.resumeCapacity(s);
  const day = dayInTz(ctx.now(), ctx.cfg.tz);
  const createdToday = ctx.store.countHHResumesCreatedToday(user.id, day);
  const max = Math.min(cap.max - cap.created, user.poolExpandPerDay - createdToday);
  ctx.log.info("pool", `expand: capacity ${cap.created}/${cap.max}, created today ${createdToday}, can add ${Math.max(0, max)}`, { max });
  if (max <= 0 || !pool.length) return;
  await ctx.browser.close();
  await ctx.memoryGuard("pool");
  const variants = await ctx.llm.proposePoolVariants(profile, pool, max);
  stats.llmCall();
  if (!variants.length) return;
  const s2 = await ctx.browser.openHH(user);
  const nowISO = ctx.now().toISOString();
  for (const v of variants.slice(0, max)) {
    ctx.checkAbort();
    const base = pool.find((r) => r.hhResumeId === v.based_on_resume_id) ?? pool[0];
    if (!base) break;
    if (ctx.req.dryRun) {
      ctx.log.info("pool", `[dry-run] would create "${v.title}" from "${base.title}"`);
      continue;
    }
    try {
      const newId = await ctx.hh.duplicateResume(s2, base.hhResumeId, { title: v.title, about: v.about, keySkills: v.key_skills });
      ctx.store.upsertHHResume({
        userId: user.id,
        hhResumeId: newId,
        title: v.title,
        url: `https://hh.ru/resume/${newId}`,
        direction: v.direction,
        summary: { direction: v.direction, seniority: "", key_skills: v.key_skills, one_line: v.about.slice(0, 200) },
        isGenerated: true,
        syncedAt: nowISO,
      });
      ctx.log.info("pool", `created "${v.title}" (${newId})`, { hh_resume_id: newId });
    } catch (e) {
      ctx.log.error("pool", `create "${v.title}" failed: ${errMessage(e)}`);
    }
    await ctx.throttle.afterMutation();
  }
}
