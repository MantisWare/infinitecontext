-- Phase 4: centralized multi-device sync (per-user monotonic cursor + change log)

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS sync_user_state (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  head_sequence BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_change_log (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  op TEXT NOT NULL,
  context_id TEXT,
  client_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, sequence),
  UNIQUE (user_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_change_log_user_seq ON sync_change_log (user_id, sequence);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  client_id TEXT,
  sequence BIGINT NOT NULL,
  left_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  right_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user_created ON sync_conflicts (user_id, created_at DESC);
