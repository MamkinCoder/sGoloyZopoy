# sGoloyZopoy architecture: batch runs, the always-on agent, the knowledge base

Status: design contract for the rebuild started 2026-09-24. Builders implement against this file; change
it in the same commit when reality forces a deviation.

## 1. Two execution planes

| | Batch runs | Always-on agent |
|---|---|---|
| What | 12:00 hh + habr apply, career `rotate` chunks, manual runs, send/inspect/retailor/force | employer chats, Telegram interactions, knowledge-base questions, anything reactive |
| Engine | `runner/service.ts` (one main slot, watchdog, `runs` table, reports) | `agent/` job queue worker inside `sgz serve` (`jobs` table) |
| Browser | main Chrome profile `chrome-profile` | agent profile `chrome-profile-chat` (same hh/habr cookies) |
| Trigger | scheduler / autopilot tick / API | recurring schedules + events (new chat message, Telegram tap, KB answer) |
| Failure unit | a whole run | one job (retries with backoff, then `failed` + alert) |

The planes never wait for each other. Batch runs no longer touch chats at all. The runner's `chats` slot
(added 2026-09-24) is replaced by the agent.

## 2. The agent: a persistent job queue

`sgz serve` starts `createAgent(deps)`; it owns a loop and a handler registry.

```
jobs(id, kind, key UNIQUE-when-open, payload_json, state, priority, run_after, attempts, max_attempts,
     last_error, lease_until, created_at, updated_at)
state: queued -> running -> done | failed | queued (retry, run_after = now + backoff)
```

- `enqueue(kind, payload, {key, runAfter, priority})`. A `key` dedupes: at most one open (`queued`/`running`)
  job per key, so "sync chats" or "draft task 42" can be requested from ten places safely.
- **Resources.** A handler declares `needs: "browser" | "llm" | "none"`. The worker runs at most one browser
  job at a time (one agent Chrome), at most `SGZ_CLAUDE_PARALLEL` LLM jobs (the existing claude semaphore),
  `none` jobs freely. Browser is opened lazily and closed after `AGENT_BROWSER_IDLE_MS` without browser jobs.
- **Recurring schedules** are rows in code, e.g. `{kind: "chats.sync", every: 5 min}`. A tick enqueues them
  by key; no job, no work.
- **Crash safety.** `running` jobs whose `lease_until` passed are requeued at boot and by the loop.
  Every handler is idempotent (reads state from the DB, never from memory).
- **Observability.** `GET /api/agent/jobs?state=` + a panel section; a job that exhausts retries alerts
  once in Telegram (dedup via the existing alert pattern). The chat stall alert watches `chats.sync`.

Handlers are the unit of extension: new always-on features = new job kinds, not new timers.

## 3. Chat replies as a state machine

One **reply task** per employer turn (one or more consecutive employer messages in a thread).

```
chat_tasks(id, thread_id, message_ids_json, state, topics_json, draft, tg_message_id, attempts, last_error,
           created_at, updated_at)
state: new -> triage -> awaiting_review -> drafting -> ready -> sending -> sent
                                  \-> superseded (employer wrote again before we sent: merged into a new task)
       any -> failed (after retries; alerted)
```

Jobs (all keyed by task id, so repeats are harmless):
1. `chats.sync` (browser, every 5 min and right after any send): read chat lists hh + habr, store new
   messages, open a task for every thread with unanswered employer messages. New employer messages on a thread
   with an open unsent task mark it `superseded` and open a fresh task covering all unanswered messages.
2. `chats.triage` (llm): decide what the turn needs: `topics` = technologies/skills the employer asks about
   (normalized to KB tags), `kind` = question | scheduling | test task | rejection | bot survey | ack-only.
   Ack-only and rejection keep today's behavior (no reply / feedback request). Otherwise -> review.
3. **Review gate** (`kb.review`, none): for every topic, a KB review item (section 4). While any item is
   unresolved the task stays `awaiting_review`. Mode setting `kb_review_mode`: `always` (current: every topic
   is shown to Yaroslav) | `new_only` (only topics without stories) | `off`.
4. `chats.draft` (llm): when all review items are resolved, write the reply from the KB stories of the topics
   + profile + vacancy + history (answer_chat rules: always forward, Moscow office + relocation, never claim
   what the KB marks `no`). -> `ready`.
5. `chats.send` (browser): send, re-read the thread to confirm our message is there, mark messages handled,
   `sent`. Enqueue `chats.sync` for the same thread shortly after (hh AI assistants reply within seconds).

A Telegram tap or a typed story only writes to the DB and enqueues `chats.draft` / `kb.review` for that
task: instant, restart-proof, independent of any run.

### As built in phase 1 (deviations from the sketch above, 2026-09-24)

- `chat_tasks` also has `user_id`, `target` (hh chat url / Habr login, where `chats.send` writes), `choices_json`
  (quick-reply buttons of an hh chat-bot question), `kind` and `reminded`. Terminal state `closed` = handled
  without a reply (ack-only, rejection, empty draft, answered by hand, chat closed); `sent` always means a reply
  went out. State changes are compare-and-set, so a sync superseding a task while its draft is written is safe.
- The review step is job `chats.review` behind `ReviewGate` (`agent/chats/review.ts`: `prefill / ask / record /
  card`); phase 1's gate reads `verified_skills` / `never_claim_skills` + learned answers and sends one grouped
  card (`ct:<task>:<topic>:y|n`). Phase 3 replaced the gate with the KB review (§4 as built); `tasks.ts` only gained the KB block for the draft, `expire` on fallback and carrying answers into the fresh task when `chats.send` supersedes.
  The 2 h reminder and 12 h fallback are delayed jobs `chats.remind` / `chats.fallback`; the invitation brief is
  `chats.prep` (llm). A task whose job failed is not reopened until the employer writes again.
- The re-sync after a send is the normal full `chats.sync` pulled to +30 s (key dedupe), not a per-thread sync:
  unchanged threads cost one list read.
- hh chat-bot surveys (the questionnaire widget) are still answered inside `chats.sync` (one LLM call inside a
  browser job); a job of their own if they get frequent.
- The agent's tables are on `SqliteStore` (`db/jobs.ts`, `db/chat-tasks.ts`, `db/kb-reviews.ts`), not on the shared `Store` contract:
  only the agent and the API view (`ApiDeps.agent`) use them. Stage `chats` is gone from runs entirely.

## 4. Knowledge base (the seeker's experience, replacing "master CV" as the source of truth)

```
kb_tags(id, user_id, name, aliases_json, category, status: yes|no|unknown, updated_at)
kb_stories(id, user_id, title, company, period, context, did, result, source: seed|telegram|panel,
           confirmed INTEGER, hash, created_at, updated_at)
kb_story_tags(story_id, tag_id)
kb_reviews(id, user_id, task_id NULL, tag_id, state: pending|confirmed|expanded|denied|expired,
           tg_message_id, prompt, created_at, resolved_at)
```

- A **tag** is a technology or skill (Grafana, React, RAG, "code review", "system design") with aliases
  (react.js, реакт). `status` replaces `verified_skills` / `never_claim_skills` (kept in sync for older
  code paths until they read the KB directly).
- A **story** is what was done: company + period + context + what I did + result/metrics, linked to many
  tags. Stories are the only material CVs, letters and chat answers may use; anything not in a story or the
  profile is not claimed.
- **Seeding** (`sgz kb seed --user`): one LLM pass over base CVs, profile.yaml (+ extra facts), the Habr
  proposal and hh resume texts -> stories + tags, `source: seed, confirmed: 0`. Re-runnable (idempotent by
  content hash), never deletes human-added stories.
  As built (phase 2): `kb_stories.hash` (added to the doc's schema) holds the content hash of a story as first
  inserted, so an edited seed story is not re-added by the next seed; a seed only adds, it never edits or
  deletes rows. hh resume texts are not read yet (the base CVs carry the same facts). Tag statuses are
  deterministic: `verified_skills` -> `yes`, `never_claim_skills` -> `no`, everything else `unknown`; an existing
  tag's status changes only while `unknown`. Numbers, periods and companies in stories survive only when present
  in the sources (`kb/write.ts guardStory`). `--dry-run [--out f]` writes the JSON without a DB, `--from f` imports
  such a JSON without the LLM (seed on the Mac, import on the Pi). `sgz kb list --user [--tag]` prints it.
- **Profile sync** (until consumers read the KB): `syncProfileSkills` after every status change, `sgz db
  import-profile` applies it too. A `yes` tag is added to `verified_skills` and removed from `never_claim_skills`,
  `no` the other way round, `unknown` tags and skills without a tag are left alone (union, never a replace).
- **Ingest** (`kb/llm.ts ingestKb`, pure, phase 3 calls it): the human's text -> 1..3 stories, numbers only from
  that text; `saveIngested` stores them `confirmed` and marks the asked tag `yes`.
- **Telegram review card** (one per chat task, all topics in one message):
  ```
  НЕОЛАНТ спрашивает: «Писали unit/компонентные тесты на Jest или Vitest?»
  Jest: 1 история (Яндекс: ...). [Подтвердить] [Дополнить] [Нет навыка]
  Vitest: пусто. [Дополнить] [Нет навыка]
  ```
  «Дополнить» -> the bot asks for a story about the tag; the next free-text message in that chat is the
  answer -> `kb.ingest` (llm) turns it into a structured story (never inventing numbers) -> saved, card updated.
  «Нет навыка» -> tag status `no`. When every topic is resolved the task moves to drafting.
  As built (phase 3, `agent/chats/review.ts` `kbReviewGate`, the phase-1 skills gate is deleted): the step is still
  job `chats.review` behind `ReviewGate` (+ `expire(taskId)` for the fallback, `record` takes the task id). Buttons
  are one row per topic «Подтвердить X» «Дополнить X» «Нет навыка X» (`kr:<review id>:c|e|d`; «Подтвердить» only
  with stories or a `yes` tag, it also confirms the ≤3 stories shown). `kb_reviews` gained `topic` (the task's
  name for it), `awaiting_chat` / `awaiting_at` (migration `007c`): «Дополнить» marks the review as waiting in the
  tapped chat (`TapReply.say` sends the question there), `kbText` routes the next plain message of that chat to
  job `kb.ingest` (llm) before `/mock`, and asks the next waiting review, oldest first. After the ingest the card is
  edited via `Notifier.edit`. A topic the KB does not know becomes a tag with the profile's yes/no when listed,
  else `unknown`. `new_only` also skips tags already `no`; `off` answers from the tag status (unknown = not
  claimed). Human answers also write `skills_learned:<user>` so `withLearnedSkills` never contradicts the KB.
  `chats.draft` passes `renderKb(kbFor(topics + vacancy + question))` with this task's answers as statuses into
  `answer_chat` (`{{kb}}` block). Old `ct:` taps map to confirm / no skill.
- **Consumers** (all through one module `kb/context.ts`: `kbFor(userId, {tags?, text?}, budget)` returning
  ranked stories + tag statuses, rendered for prompts):
  chat drafting, questionnaire answers, cover letters, interview prep/study packs, `tailor_cv` (LaTeX CVs are
  forged from base CV structure = jobs/dates/contacts + KB stories as bullet material), hh tailored resume
  copies, the Habr profile proposal.
  As built (phase 4, everything but chat drafting): `kbBrief(store, userId, {text, tags?, companies?}, budget)` in
  `kb/context.ts` wraps `kbFor` for application texts and returns `{text, no}` (`KbBrief`, shared): `text` is the
  rendered block (default budget `KB_BRIEF_BUDGET` = 3000 chars of stories; Habr proposal 6000), `no` = names +
  aliases of the status-`no` tags. Status-`no` tags never reach a prompt's KB block: they leave story tag lists and
  topics, sentences naming them leave the stories, a story whose title names one is dropped. `withKbNever(profile,
  kb)` appends `no` to `never_claim_skills`, so the existing guards (blockedTech, sanitizeLetter, guardTailored,
  guardTailoredCV, validateCV, guardStudy, guardProposal) and the prompts' «никогда не заявлять» list enforce them.
  `kbForVacancy(store, userId, vacancy(s), extra)` = kbBrief over title + description (+ questions / invitation).
  Every prompt gets the same partial `prompts/_kb.md` (a `## База знаний` section, absent when the KB is empty).
  Wiring: `DecideInput.kb(vacancies)` builds one block per decide batch (`runner/learn.ts decideKb`, part of
  `decideExtras`; the force paths pass it too) -> hh/Habr letters + `tailored` about; the LLMClient methods
  `answerQuestionnaire`, `tailorCV`, `coverLetterCareer`, `interviewPrep`, `interviewStudy` take an optional last
  `kb` argument (fakes/tests without it behave as before); `tailor_cv` gets only stories whose company matches a base
  CV job (companyKey, either way contained), job identity/periods still come from the base CV (guardTailoredCV +
  validateCV unchanged). A KB read error or an empty KB gives `undefined`: no section, never a failed application.
  Not wired yet: the agent's bot-survey questionnaires in `agent/chats/hh.ts` (phase 3 owns that file).
- **Panel**: «База знаний» page: tags (status, story count), stories (edit, confirm, delete), add story.
  API under `/api/users/:slug/kb/*`.

## 5. Build phases

1. Agent queue + chat task state machine + one grouped Telegram card per task (skills gating on the existing
   yes/no data), replacing the runner's chat slot and the settings-key skill state.
2. KB tables, seed command, API, panel page.
3. KB review gate in chats (always mode), Дополнить flow via free-text, drafting from stories.
4. KB as the source for CVs, letters, questionnaires, prep.
