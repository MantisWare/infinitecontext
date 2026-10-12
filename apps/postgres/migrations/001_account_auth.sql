-- Account auth (Phase 1). Login passwords are separate from vault KEK (Phase 2+).

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
  replaced_refresh_token_hash TEXT UNIQUE,
  prior_replaced_refresh_token_hash TEXT UNIQUE,
  refresh_grace_expires_at TIMESTAMPTZ,
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
  tokens_delivered_at TIMESTAMPTZ,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
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
