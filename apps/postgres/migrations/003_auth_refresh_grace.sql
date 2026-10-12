-- Refresh reuse grace anchor and one prior generation for theft detection.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prior_replaced_refresh_token_hash TEXT UNIQUE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refresh_grace_expires_at TIMESTAMPTZ;
