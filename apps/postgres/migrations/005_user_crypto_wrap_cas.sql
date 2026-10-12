-- Compare-and-swap vault wrap updates + DEK proof tag for PATCH /auth/crypto.

ALTER TABLE user_crypto
  ADD COLUMN IF NOT EXISTS wrapped_dek_prev BYTEA,
  ADD COLUMN IF NOT EXISTS wrapped_dek_recovery_prev BYTEA,
  ADD COLUMN IF NOT EXISTS dek_proof_tag BYTEA;
