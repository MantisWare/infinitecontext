import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function postgresDbNameFromUrl(databaseUrl: string): string {
    const parsed = new URL(databaseUrl.replace(/^postgres:/, 'postgresql:'));
    const name = parsed.pathname.replace(/^\//, '');
    if (!name) {
        throw new Error(`Could not parse database name from ${databaseUrl}`);
    }
    return name;
}

/** Applies init.sql + migrations to the DB named in databaseUrl (up/down/up verify chain). */
export function verifyMigrationChainForDatabase(databaseUrl: string, postgresPassword: string): boolean {
    const script = path.resolve(process.cwd(), '../postgres/scripts/verify-migration-chain.sh');
    const dbName = postgresDbNameFromUrl(databaseUrl);
    const res = spawnSync('bash', [script], {
        encoding: 'utf8',
        timeout: 180_000,
        env: {
            ...process.env,
            POSTGRES_PASSWORD: postgresPassword,
            POSTGRES_DB: dbName,
            PGHOST: process.env.PGHOST ?? '127.0.0.1',
            PGPORT: process.env.PGPORT ?? '5432',
        },
    });
    if (res.status !== 0) {
        console.warn('live postgres migration verify failed\n', res.stderr || res.stdout);
    }
    return res.status === 0;
}
