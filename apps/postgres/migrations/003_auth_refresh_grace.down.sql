ALTER TABLE sessions DROP COLUMN IF EXISTS refresh_grace_expires_at;
ALTER TABLE sessions DROP COLUMN IF EXISTS prior_replaced_refresh_token_hash;
