-- hh_resumes.synced_at is bumped on every pool sync, so it cannot tell when a generated resume was
-- created. countHHResumesCreatedToday needs a stable creation timestamp.
ALTER TABLE hh_resumes ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
UPDATE hh_resumes SET created_at = synced_at WHERE created_at = '';
