ALTER TABLE user_crypto
  DROP COLUMN IF EXISTS vault_passphrase_required,
  DROP COLUMN IF EXISTS crypto_initialized_at,
  DROP COLUMN IF EXISTS recovery_kdf_salt,
  DROP COLUMN IF EXISTS wrapped_dek_recovery;
