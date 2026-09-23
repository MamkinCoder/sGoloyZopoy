-- Post-interview outcome (next | rejected | silence | offer), tapped in Telegram or set in the panel,
-- plus a flag so the «как прошло?» question goes out once per interview time.
ALTER TABLE chat_threads ADD COLUMN interview_outcome TEXT;
ALTER TABLE chat_threads ADD COLUMN outcome_asked INTEGER NOT NULL DEFAULT 0;
