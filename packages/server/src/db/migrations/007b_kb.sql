-- Knowledge base (docs/ARCHITECTURE.md section 4): the seeker's tags (skills) and stories (what was done).
-- kb_stories.hash: content hash of the story as first inserted; re-seeding skips stories already present.
CREATE TABLE kb_tags (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    category     TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('yes','no','unknown')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_kb_tags_name ON kb_tags(user_id, name COLLATE NOCASE);

CREATE TABLE kb_stories (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    company    TEXT NOT NULL DEFAULT '',
    period     TEXT NOT NULL DEFAULT '',
    context    TEXT NOT NULL DEFAULT '',
    did        TEXT NOT NULL DEFAULT '',
    result     TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL CHECK (source IN ('seed','telegram','panel')),
    confirmed  INTEGER NOT NULL DEFAULT 0,
    hash       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kb_stories_user ON kb_stories(user_id);
CREATE INDEX idx_kb_stories_hash ON kb_stories(user_id, hash);

CREATE TABLE kb_story_tags (
    story_id INTEGER NOT NULL REFERENCES kb_stories(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES kb_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (story_id, tag_id)
);
CREATE INDEX idx_kb_story_tags_tag ON kb_story_tags(tag_id);

-- Filled by phase 3 (review gate in chats); task_id points at chat_tasks once that table exists.
CREATE TABLE kb_reviews (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id       INTEGER,
    tag_id        INTEGER NOT NULL REFERENCES kb_tags(id) ON DELETE CASCADE,
    state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','expanded','denied','expired')),
    tg_message_id TEXT NOT NULL DEFAULT '',
    prompt        TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    resolved_at   TEXT
);
CREATE INDEX idx_kb_reviews_task ON kb_reviews(task_id);
CREATE INDEX idx_kb_reviews_open ON kb_reviews(user_id, state);
