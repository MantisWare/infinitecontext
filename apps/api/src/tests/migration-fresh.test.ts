import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const script = path.resolve(process.cwd(), '../postgres/scripts/verify-migration-chain.sh');

function expectedIcn(publicId: string): string {
    const hex = createHash('sha256').update(publicId, 'utf8').digest('hex').slice(0, 24);
    return `icn_${hex}`;
}

function dropFreshDatabase(dbName: string) {
    const pgHost = process.env.PGHOST ?? '127.0.0.1';
    const pgPort = process.env.PGPORT ?? '5432';
    const pgUser = process.env.POSTGRES_USER ?? 'infinitecontext';
    const pgPassword = process.env.POSTGRES_PASSWORD;
    if (!pgPassword) return;
    const adminUrl = `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/postgres`;
    spawnSync(
        'psql',
        [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`],
        { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pgPassword } },
    );
}

let postgresReady = false;

before(() => {
    postgresReady = Boolean(process.env.POSTGRES_PASSWORD);
    if (!postgresReady) {
        console.warn(
            'migration-fresh skipped: set POSTGRES_PASSWORD (database owner) to run init+migration chain tests.',
        );
    }
});

describe('postgres migration chain (fresh DB)', () => {
    it('applies init + all migrations including 008 backfill (up/down/up)', (t) => {
        if (!postgresReady) {
            t.skip('POSTGRES_PASSWORD is required — run migrations as the database owner (pgcrypto CREATE)');
            return;
        }

        const dbName = `ic_migrate_fresh_${Date.now()}`;
        try {
            const res = spawnSync('bash', [script], {
                encoding: 'utf8',
                timeout: 180_000,
                env: {
                    ...process.env,
                    POSTGRES_DB: dbName,
                    PGHOST: process.env.PGHOST ?? '127.0.0.1',
                    PGPORT: process.env.PGPORT ?? '5432',
                },
            });
            assert.equal(res.status, 0, res.stderr || res.stdout);
            assert.match(res.stdout ?? '', /Migration chain init/);

            const dbUrl = `postgresql://${process.env.POSTGRES_USER ?? 'infinitecontext'}:${process.env.POSTGRES_PASSWORD}@${process.env.PGHOST ?? '127.0.0.1'}:${process.env.PGPORT ?? '5432'}/${dbName}`;
            const legacyMsgId = 'msg_migration_icn_legacy_round7';
            const seed = spawnSync(
                'psql',
                [
                    dbUrl,
                    '-v',
                    'ON_ERROR_STOP=1',
                    '-c',
                    `
INSERT INTO projects (name, public_id) VALUES ('icn-migrate-test', 'proj_icn_migrate_test');
INSERT INTO nodes (public_id, project_id, type, content, metadata, context_id)
VALUES (
  '${legacyMsgId}',
  (SELECT id FROM projects WHERE public_id = 'proj_icn_migrate_test'),
  'message',
  '{"text":"legacy"}'::jsonb,
  '{}'::jsonb,
  'ctx_icn_migrate_test'
);
`,
                ],
                { encoding: 'utf8', env: { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD } },
            );
            assert.equal(seed.status, 0, seed.stderr || seed.stdout);

            const backfill = spawnSync(
                'psql',
                [
                    dbUrl,
                    '-v',
                    'ON_ERROR_STOP=1',
                    '-f',
                    path.resolve(process.cwd(), '../postgres/migrations/008_backfill_ic_client_node_ids.sql'),
                ],
                { encoding: 'utf8', env: { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD } },
            );
            assert.equal(backfill.status, 0, backfill.stderr || backfill.stdout);

            const check = spawnSync(
                'psql',
                [
                    dbUrl,
                    '-t',
                    '-A',
                    '-c',
                    `SELECT metadata->>'ic_client_node_id' FROM nodes WHERE public_id = '${legacyMsgId}';`,
                ],
                { encoding: 'utf8', env: { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD } },
            );
            assert.equal(check.status, 0, check.stderr || check.stdout);
            assert.equal(String(check.stdout ?? '').trim(), expectedIcn(legacyMsgId));
        } finally {
            dropFreshDatabase(dbName);
        }
    });
});
