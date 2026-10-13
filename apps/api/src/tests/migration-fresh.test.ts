import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const script = path.resolve(process.cwd(), '../postgres/scripts/verify-migration-chain.sh');

describe('postgres migration chain (fresh DB)', () => {
    it('applies init + all migrations including 008 backfill (up/down/up)', () => {
        if (!process.env.POSTGRES_PASSWORD) {
            return;
        }
        const res = spawnSync('bash', [script], {
            encoding: 'utf8',
            timeout: 180_000,
            env: {
                ...process.env,
                POSTGRES_DB: process.env.MIGRATION_VERIFY_DB ?? 'infinitecontext_verify_r6',
                PGHOST: process.env.PGHOST ?? '127.0.0.1',
                PGPORT: process.env.PGPORT ?? '5432',
            },
        });
        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.match(res.stdout ?? '', /Migration chain init/);
    });
});
