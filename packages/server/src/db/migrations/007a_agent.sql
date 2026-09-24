-- Always-on agent (docs/ARCHITECTURE.md §2-3): a persistent job queue and one reply task per employer turn.

CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,
    key          TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    state        TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
    priority     INTEGER NOT NULL DEFAULT 0,
    run_after    TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error   TEXT NOT NULL DEFAULT '',
    lease_until  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
-- At most one open job per key: "sync chats" / "draft task 42" can be requested from anywhere.
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_open_key ON jobs(key) WHERE key IS NOT NULL AND state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(state, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_kind ON jobs(kind, state, updated_at);

CREATE TABLE IF NOT EXISTS chat_tasks (
    id               INTEGER PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id        INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    -- new | triage | awaiting_review | drafting | ready | sending | sent | closed | superseded | failed
    state            TEXT NOT NULL DEFAULT 'new',
    message_ids_json TEXT NOT NULL DEFAULT '[]',
    -- hh chat url or Habr login: where chats.send writes
    target           TEXT NOT NULL DEFAULT '',
    -- quick-reply buttons of an hh chat-bot question, the reply must be one of them
    choices_json     TEXT NOT NULL DEFAULT '[]',
    kind             TEXT NOT NULL DEFAULT '',
    topics_json      TEXT NOT NULL DEFAULT '[]',
    draft            TEXT NOT NULL DEFAULT '',
    tg_message_id    INTEGER,
    reminded         INTEGER NOT NULL DEFAULT 0,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_tasks_thread ON chat_tasks(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_tasks_state ON chat_tasks(state);
