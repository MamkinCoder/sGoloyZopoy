-- 001_init.sql — full initial schema. Owned by workstream A; other agents READ this, do not edit.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id                 INTEGER PRIMARY KEY,
    slug               TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    tg_chat_id         TEXT NOT NULL DEFAULT '',
    daily_limit_hh     INTEGER NOT NULL DEFAULT 25,
    daily_limit_career INTEGER NOT NULL DEFAULT 10,
    active             INTEGER NOT NULL DEFAULT 1,
    allow_other_country INTEGER NOT NULL DEFAULT 1,
    pool_expand_per_day INTEGER NOT NULL DEFAULT 2,
    opus_enabled       INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    facts_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS hh_resumes (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hh_resume_id TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    url          TEXT NOT NULL,
    direction    TEXT NOT NULL DEFAULT '',
    summary_json TEXT NOT NULL DEFAULT '{}',
    is_generated INTEGER NOT NULL DEFAULT 0,
    synced_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hh_resumes_user ON hh_resumes(user_id);

CREATE TABLE IF NOT EXISTS vacancies (
    id               INTEGER PRIMARY KEY,
    source           TEXT NOT NULL,
    external_id      TEXT NOT NULL,
    url              TEXT NOT NULL,
    title            TEXT NOT NULL,
    company          TEXT NOT NULL DEFAULT '',
    salary_from      INTEGER NOT NULL DEFAULT 0,
    salary_to        INTEGER NOT NULL DEFAULT 0,
    currency         TEXT NOT NULL DEFAULT '',
    description_text TEXT NOT NULL DEFAULT '',
    has_test         INTEGER NOT NULL DEFAULT 0,
    requires_letter  INTEGER NOT NULL DEFAULT 0,
    area             TEXT NOT NULL DEFAULT '',
    work_format      TEXT NOT NULL DEFAULT '',
    published_at     TEXT,
    first_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    archived         INTEGER NOT NULL DEFAULT 0,
    dedup_hash       TEXT NOT NULL DEFAULT '',
    UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_vacancies_dedup ON vacancies(dedup_hash);

CREATE TABLE IF NOT EXISTS applications (
    id                  INTEGER PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vacancy_id          INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
    hh_resume_id        INTEGER REFERENCES hh_resumes(id) ON DELETE SET NULL,
    generated_resume_id INTEGER,
    run_id              INTEGER NOT NULL DEFAULT 0,
    attempt             INTEGER NOT NULL DEFAULT 1,
    status              TEXT NOT NULL,
    reason_detail       TEXT NOT NULL DEFAULT '',
    cover_letter        TEXT NOT NULL DEFAULT '',
    llm_decision_json   TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(user_id, vacancy_id, attempt)
);
-- one SENT per (user, vacancy), any number of failed/skipped attempts
CREATE UNIQUE INDEX IF NOT EXISTS ux_applications_sent ON applications(user_id, vacancy_id) WHERE status = 'SENT';
CREATE INDEX IF NOT EXISTS idx_applications_user_created ON applications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_applications_run ON applications(run_id);

CREATE TABLE IF NOT EXISTS questionnaire_answers (
    id             INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    question_json  TEXT NOT NULL,
    answer_json    TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_qa_application ON questionnaire_answers(application_id);

CREATE TABLE IF NOT EXISTS chat_threads (
    id                INTEGER PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hh_negotiation_id TEXT NOT NULL UNIQUE,
    is_bot            INTEGER NOT NULL DEFAULT 0,
    vacancy_id        INTEGER REFERENCES vacancies(id) ON DELETE SET NULL,
    employer          TEXT NOT NULL DEFAULT '',
    state             TEXT NOT NULL DEFAULT 'new',
    last_seen_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY,
    thread_id   INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    hh_message_id TEXT,
    direction   TEXT NOT NULL,
    author      TEXT NOT NULL,
    text        TEXT NOT NULL,
    is_question INTEGER NOT NULL DEFAULT 0,
    answered    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_messages_hh ON chat_messages(thread_id, hh_message_id) WHERE hh_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS generated_resumes (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vacancy_id INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
    tex_path   TEXT NOT NULL,
    pdf_path   TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_generated_resumes_user ON generated_resumes(user_id);

CREATE TABLE IF NOT EXISTS career_sites (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    adapter     TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source      TEXT NOT NULL,
    trigger     TEXT NOT NULL,
    started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    stats_json  TEXT NOT NULL DEFAULT '{}',
    tg_sent     INTEGER NOT NULL DEFAULT 0,
    error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);

CREATE TABLE IF NOT EXISTS run_events (
    id        INTEGER PRIMARY KEY,
    run_id    INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    level     TEXT NOT NULL DEFAULT 'info',
    stage     TEXT NOT NULL DEFAULT '',
    message   TEXT NOT NULL,
    data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS llm_calls (
    id           INTEGER PRIMARY KEY,
    run_id       INTEGER,
    task         TEXT NOT NULL,
    model        TEXT NOT NULL,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    result_chars INTEGER NOT NULL DEFAULT 0,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    ok           INTEGER NOT NULL,
    error        TEXT NOT NULL DEFAULT '',
    attempt      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
