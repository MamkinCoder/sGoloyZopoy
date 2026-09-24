-- KB review gate in chats (docs/ARCHITECTURE.md section 3 step 3): which task topic a review is for, and
-- «Дополнить»: the Telegram chat whose next free-text message is the story (asked one at a time, oldest first).
ALTER TABLE kb_reviews ADD COLUMN topic TEXT NOT NULL DEFAULT '';
ALTER TABLE kb_reviews ADD COLUMN awaiting_chat TEXT NOT NULL DEFAULT '';
ALTER TABLE kb_reviews ADD COLUMN awaiting_at TEXT;
CREATE INDEX idx_kb_reviews_awaiting ON kb_reviews(awaiting_chat, awaiting_at) WHERE awaiting_chat != '';
