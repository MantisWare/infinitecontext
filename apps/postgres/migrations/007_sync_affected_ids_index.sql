-- Speed stale-delete EXISTS checks on affected / deleted client id arrays
CREATE INDEX IF NOT EXISTS idx_sync_change_log_affected_client_ids
  ON sync_change_log USING gin ((COALESCE(payload->'affected_client_ids', '[]'::jsonb)));

CREATE INDEX IF NOT EXISTS idx_sync_change_log_deleted_client_ids
  ON sync_change_log USING gin ((COALESCE(payload->'deleted_client_ids', '[]'::jsonb)));
