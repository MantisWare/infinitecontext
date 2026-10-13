-- Revert deterministic icn backfill from 008 (requires pgcrypto from up migration).
UPDATE nodes
SET metadata = metadata - 'ic_client_node_id'
WHERE type = 'message'
  AND COALESCE((content->>'__ic_enc')::int, 0) <> 1
  AND metadata->>'ic_client_node_id' = 'icn_' || substr(encode(digest(public_id, 'sha256'), 'hex'), 1, 24);
