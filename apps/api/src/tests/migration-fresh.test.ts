import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const script = path.resolve(process.cwd(), '../postgres/scripts/verify-migration-chain.sh');

function expectedIcn(publicId: string): string {
    const hex = createHash('sha256').update(publicId, 'utf8').digest('hex').slice(0, 24);
    return `icn_${hex}`;
}

function parseMigrationVerifyUrl(stdout: string): string {
    const line = (stdout ?? '').split('\n').find((row) => row.startsWith('MIGRATION_VERIFY_DATABASE_URL='));
    assert.ok(line, 'verify-migration-chain.sh must print MIGRATION_VERIFY_DATABASE_URL');
    return line.slice('MIGRATION_VERIFY_DATABASE_URL='.length).trim();
}

function dropFreshDatabase(dbUrl: string, dbName: string) {
    const pgPassword = process.env.POSTGRES_PASSWORD;
    if (!pgPassword) return;
    spawnSync(
        'psql',
        [dbUrl.replace(/\/[^/]+$/, '/postgres'), '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`],
        { encoding: 'utf8', env: { ...process.env, PGPASSWORD: pgPassword } },
    );
}

describe('postgres migration chain (fresh DB)', () => {
    it('applies init + all migrations including 008 backfill (up/down/up)', () => {
        assert.ok(
            process.env.POSTGRES_PASSWORD,
            'POSTGRES_PASSWORD is required — run migrations as the database owner (pgcrypto CREATE)',
        );

        const dbName = `ic_migrate_fresh_${Date.now()}`;
        let dbUrlForCleanup = '';
        try {
            const res = spawnSync('bash', [script], {
                encoding: 'utf8',
                timeout: 180_000,
                env: {
                    ...process.env,
                    POSTGRES_DB: dbName,
                    MIGRATION_VERIFY_TEARDOWN: '1',
                },
            });
            assert.equal(res.status, 0, res.stderr || res.stdout);
            assert.match(res.stdout ?? '', /Migration chain init/);

            const dbUrl = parseMigrationVerifyUrl(res.stdout ?? '');
            dbUrlForCleanup = dbUrl;

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
            if (dbUrlForCleanup) {
                dropFreshDatabase(dbUrlForCleanup, dbName);
            }
        }
    });
});
