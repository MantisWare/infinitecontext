-- Idempotent upgrades for databases created from an earlier 001 revision.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS replaced_refresh_token_hash TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_sessions_replaced_refresh ON sessions (replaced_refresh_token_hash);

ALTER TABLE oauth_device_flows ADD COLUMN IF NOT EXISTS tokens_delivered_at TIMESTAMPTZ;
ALTER TABLE oauth_device_flows DROP COLUMN IF EXISTS session_bundle;

DROP TABLE IF EXISTS oauth_states;
