-- Phase 2/3: dual DEK wrap (passphrase + recovery key) and vault status flags.

ALTER TABLE user_crypto
  ADD COLUMN IF NOT EXISTS wrapped_dek_recovery BYTEA,
  ADD COLUMN IF NOT EXISTS recovery_kdf_salt BYTEA,
  ADD COLUMN IF NOT EXISTS crypto_initialized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vault_passphrase_required BOOLEAN NOT NULL DEFAULT FALSE;
