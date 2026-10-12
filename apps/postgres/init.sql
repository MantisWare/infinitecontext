CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  public_id TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  name TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nodes (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parent_id TEXT,
  prev_id TEXT,
  context_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_project_type_context
  ON nodes (project_id, type, context_id);

CREATE INDEX IF NOT EXISTS idx_nodes_context
  ON nodes (context_id);

CREATE INDEX IF NOT EXISTS idx_nodes_prev
  ON nodes (prev_id);

CREATE INDEX IF NOT EXISTS idx_nodes_created_at
  ON nodes (created_at);

CREATE INDEX IF NOT EXISTS idx_nodes_metadata
  ON nodes USING GIN (metadata);

CREATE INDEX IF NOT EXISTS idx_api_keys_project_id
  ON api_keys (project_id);

CREATE OR REPLACE VIEW project_activity_daily
  WITH (security_invoker = on) AS
WITH node_activity AS (
  SELECT
    n.project_id,
    p.name AS project_name,
    DATE_TRUNC('day', n.created_at) AS activity_day,
    COALESCE(NULLIF(n.metadata->>'source', ''), 'unknown') AS source,
    COUNT(*) AS node_count,
    COUNT(*) FILTER (WHERE n.type <> 'context') AS message_count,
    COUNT(*) FILTER (WHERE n.type = 'context') AS context_count,
    COUNT(*) FILTER (WHERE n.type = 'context' AND n.context_id IS NULL) AS root_context_count,
    MIN(n.created_at) AS first_event_at,
    MAX(n.created_at) AS last_event_at
  FROM nodes n
  JOIN projects p ON p.id = n.project_id
  GROUP BY
    n.project_id,
    p.name,
    DATE_TRUNC('day', n.created_at),
    COALESCE(NULLIF(n.metadata->>'source', ''), 'unknown')
)
SELECT
  na.project_id,
  na.project_name,
  na.activity_day,
  na.source,
  na.node_count,
  na.message_count,
  na.context_count,
  na.root_context_count,
  na.first_event_at,
  na.last_event_at,
  MAX(ak.last_used_at) AS latest_api_key_last_used_at,
  COUNT(DISTINCT ak.id) FILTER (WHERE ak.last_used_at IS NOT NULL) AS active_api_keys
FROM node_activity na
LEFT JOIN api_keys ak ON ak.project_id = na.project_id
GROUP BY
  na.project_id,
  na.project_name,
  na.activity_day,
  na.source,
  na.node_count,
  na.message_count,
  na.context_count,
  na.root_context_count,
  na.first_event_at,
  na.last_event_at;

CREATE OR REPLACE VIEW project_activity_weekly
  WITH (security_invoker = on) AS
SELECT
  project_id,
  project_name,
  DATE_TRUNC('week', activity_day) AS activity_week,
  source,
  COUNT(*) AS active_days,
  SUM(node_count) AS node_count,
  SUM(message_count) AS message_count,
  SUM(context_count) AS context_count,
  SUM(root_context_count) AS root_context_count,
  MIN(first_event_at) AS first_event_at,
  MAX(last_event_at) AS last_event_at,
  MAX(latest_api_key_last_used_at) AS latest_api_key_last_used_at,
  MAX(active_api_keys) AS active_api_keys
FROM project_activity_daily
GROUP BY
  project_id,
  project_name,
  DATE_TRUNC('week', activity_day),
  source;

-- =============================================================================
-- Account auth (Phase 1) — login passwords are separate from vault KEK (Phase 2+)
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS identities (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_identities_user_id ON identities (user_id);

CREATE TABLE IF NOT EXISTS user_projects (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  device_name TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_kind ON auth_tokens (user_id, kind);

CREATE TABLE IF NOT EXISTS oauth_device_flows (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  device_code_hash TEXT NOT NULL UNIQUE,
  provider_device_code TEXT NOT NULL,
  user_code TEXT NOT NULL,
  verification_url TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  session_bundle JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 2+ zero-knowledge crypto metadata (empty until client encryption ships)
CREATE TABLE IF NOT EXISTS user_crypto (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kdf_salt BYTEA,
  kdf_params JSONB,
  wrapped_dek BYTEA,
  dek_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
