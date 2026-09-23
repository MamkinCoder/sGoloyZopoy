-- Interview time captured from employer chats (UTC ISO) + reminder sent flag, and the prep brief
-- generated on an invitation (InterviewPrep JSON).
ALTER TABLE chat_threads ADD COLUMN interview_at TEXT;
ALTER TABLE chat_threads ADD COLUMN interview_reminded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_threads ADD COLUMN prep_json TEXT;
