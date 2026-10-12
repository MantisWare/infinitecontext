CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE oauth_device_flows ADD COLUMN IF NOT EXISTS session_bundle JSONB;
ALTER TABLE oauth_device_flows DROP COLUMN IF EXISTS tokens_delivered_at;

DROP INDEX IF EXISTS idx_sessions_replaced_refresh;
ALTER TABLE sessions DROP COLUMN IF EXISTS replaced_refresh_token_hash;
