// Chat job kinds of the always-on agent and their schedule. Every task job is keyed by the task id.
import { cvSyncJob } from "./cvsync.js";
import { createSkillsHub } from "../../skills/hub.js";
import type { Job } from "@sgz/shared";
import { sendInterviewPrep } from "../../runner/interview.js";
import { errMessage } from "../../runner/util.js";
import type { JobHandler, Schedule } from "../queue.js";
import type { ChatEnv } from "./env.js";
import { backfillForms, gformJob } from "./gform.js";
import { syncHabrChats } from "./habr.js";
import { syncHHChats } from "./hh.js";
import { ingestFailed, ingestReview } from "./review.js";
import { draftTask, failTask, fallbackTask, remindTask, reviewTask, sendTask, triageTask } from "./tasks.js";
import { existsSync } from "node:fs";
import { paths } from "@sgz/shared";

const taskId = (job: Job): number => Number(job.payload.taskId);

/** hh + Habr chats of every active user. One user's failure fails the job (retry, then alert) after the rest ran. */
async function syncAll(env: ChatEnv): Promise<void> {
  const errors: string[] = [];
  for (const u of env.store.listUsers(true)) {
    // A user row without a profile is a placeholder (never set up): nothing to answer with.
    if (!env.store.getProfile(u.id)) continue;
    for (const [name, sync] of [
      ["hh", syncHHChats],
      ["habr", syncHabrChats],
    ] as const) {
      // Habr is opt-in: no saved login (`sgz habr-login`) means the user doesn't use it.
      if (name === "habr" && !existsSync(paths.habrCookies(env.cfg, u.slug))) continue;
      try {
        await sync(env, u);
      } catch (e) {
        errors.push(`${name} ${u.slug}: ${errMessage(e)}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
}

export function chatHandlers(env: ChatEnv): Record<string, JobHandler> {
  const onFailed = (job: Job, error: string) => failTask(env, taskId(job), error);
  return {
    "chats.sync": { needs: "browser", leaseMs: 20 * 60_000, run: () => syncAll(env) },
    "chats.triage": { needs: "llm", leaseMs: 15 * 60_000, run: (job) => triageTask(env, taskId(job)), onFailed },
    "chats.review": { needs: "none", run: (job) => reviewTask(env, taskId(job)), onFailed },
    "chats.remind": { needs: "none", run: (job) => remindTask(env, taskId(job)) },
    "chats.fallback": { needs: "none", run: (job) => fallbackTask(env, taskId(job)), onFailed },
    "chats.draft": { needs: "llm", leaseMs: 15 * 60_000, run: (job) => draftTask(env, taskId(job)), onFailed },
    "chats.gform": { needs: "llm", leaseMs: 15 * 60_000, run: (job) => gformJob(env, { threadId: Number(job.payload.threadId), url: String(job.payload.url) }) },
    "chats.gform_backfill": { needs: "none", run: async () => void backfillForms(env) },
    "chats.send": { needs: "browser", run: (job) => sendTask(env, taskId(job)), onFailed },
    // «Дополнить»: the human's story about a topic -> KB (review.ts)
    "kb.ingest": {
      needs: "llm",
      leaseMs: 15 * 60_000,
      async run(job) {
        const reviewId = Number(job.payload.reviewId);
        await ingestReview(env, reviewId, String(job.payload.text ?? ""));
        // The open «pending skills» card in the personal chat loses the skill that was just answered.
        const review = env.store.getKbReview(reviewId);
        if (review) await createSkillsHub({ store: env.store, llm: env.llm, notifier: env.notifier, chats: env, now: () => env.now() }).refreshPending(review.userId).catch(() => undefined);
      },
      onFailed: (job) => ingestFailed(env, Number(job.payload.reviewId)) },
    "cv.sync": { needs: "browser", leaseMs: 30 * 60_000, run: (job) => cvSyncJob(env, Number(job.payload.userId)) },
    "chats.prep": {
      needs: "llm",
      leaseMs: 15 * 60_000,
      async run(job) {
        const thread = env.store.getChatThread(Number(job.payload.threadId));
        if (thread) await sendInterviewPrep(env, thread, String(job.payload.invitation ?? ""));
      },
    },
  };
}

/** SGZ_CHAT_POLL_MIN (default 5, 0 = off): how often chats.sync is enqueued. */
export function chatSchedules(pollMin = Number(process.env.SGZ_CHAT_POLL_MIN ?? 5)): Schedule[] {
  return pollMin > 0 ? [{ kind: "chats.sync", everyMs: pollMin * 60_000 }, { kind: "chats.gform_backfill", everyMs: 6 * 3600_000 }] : [];
}
