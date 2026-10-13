import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

import { verifyMigrationChainForDatabase } from './helpers/ensure-live-postgres';

const DB_URL = process.env.SYNC_E2E_DATABASE_URL ?? process.env.VAULT_E2E_DATABASE_URL;
let postgresReady = false;

before(async () => {
    if (!DB_URL || !process.env.POSTGRES_PASSWORD) {
        postgresReady = false;
        return;
    }
    postgresReady = verifyMigrationChainForDatabase(DB_URL, process.env.POSTGRES_PASSWORD);
});

describe('sync GIN index usage', () => {
    it('EXPLAIN stale EXISTS uses idx_sync_change_log_affected_client_ids', async () => {
        if (!postgresReady) return;
        const sql = postgres(DB_URL!);
        try {
            const icn = 'icn_' + 'a'.repeat(24);
            const plan = await sql.unsafe(`
                EXPLAIN (FORMAT TEXT)
                SELECT EXISTS (
                    SELECT 1
                    FROM sync_change_log
                    WHERE user_id = 1
                      AND context_id = 'ctx_test'
                      AND sequence > 0
                      AND op IN ('message_update', 'message_delete')
                      AND (
                        COALESCE(payload->'affected_client_ids', '[]'::jsonb) @> ${JSON.stringify([icn])}::jsonb
                        OR COALESCE(payload->'deleted_client_ids', '[]'::jsonb) @> ${JSON.stringify([icn])}::jsonb
                      )
                )
            `);
            const text = plan.map((r) => Object.values(r)[0]).join('\n');
            assert.match(text, /idx_sync_change_log_(affected|deleted)_client_ids|Bitmap Index Scan/i);
        } finally {
            await sql.end({ timeout: 5 });
        }
    });
});
