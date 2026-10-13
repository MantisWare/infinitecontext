-- Backfill stable ic_client_node_id on plaintext message nodes (matches core deterministicClientNodeIdFromPublicId)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
UPDATE nodes
SET metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{ic_client_node_id}',
    to_jsonb(
        'icn_' || substr(encode(digest(public_id, 'sha256'), 'hex'), 1, 24)
    ),
    true
)
WHERE type = 'message'
  AND (metadata->>'ic_client_node_id' IS NULL OR metadata->>'ic_client_node_id' !~ '^icn_[0-9a-f]{24}$')
  AND COALESCE((content->>'__ic_enc')::int, 0) <> 1;
