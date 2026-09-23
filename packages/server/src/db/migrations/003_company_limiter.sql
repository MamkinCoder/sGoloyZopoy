-- Per-company spam limiter: normalized company key on vacancies + CV direction on applications,
-- so one company can be counted/locked across hh and career sources.
ALTER TABLE vacancies ADD COLUMN company_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_vacancies_company_key ON vacancies(company_key);

ALTER TABLE applications ADD COLUMN direction TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_applications_sent_lookup ON applications(user_id, status, created_at);
