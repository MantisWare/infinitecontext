DROP INDEX IF EXISTS idx_sync_conflicts_user_created;
DROP TABLE IF EXISTS sync_conflicts;

DROP INDEX IF EXISTS idx_sync_change_log_user_seq;
DROP TABLE IF EXISTS sync_change_log;

DROP TABLE IF EXISTS sync_user_state;

ALTER TABLE sessions DROP COLUMN IF EXISTS last_sync_at;
