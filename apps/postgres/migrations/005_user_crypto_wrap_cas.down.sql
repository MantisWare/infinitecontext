ALTER TABLE user_crypto
  DROP COLUMN IF EXISTS dek_proof_tag,
  DROP COLUMN IF EXISTS wrapped_dek_recovery_prev,
  DROP COLUMN IF EXISTS wrapped_dek_prev;
