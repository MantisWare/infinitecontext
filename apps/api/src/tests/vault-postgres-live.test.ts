import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { createMockGoogleOAuthClient } from '@infinitecontext/auth';
import { computeDekProof, createVaultCryptoMaterial } from '@infinitecontext/crypto';
import { createAuthRepository, createStorageAdapter } from '@infinitecontext/storage';

import { createApp } from '../app';
import type { ApiConfig } from '../types/api';
import { verifyMigrationChainForDatabase } from './helpers/ensure-live-postgres';

const TEST_AUTH_CONFIG = {
    jwtSecret: 'test-jwt-secret-must-be-at-least-32-bytes-long',
    jwtIssuer: 'http://127.0.0.1:8787',
    jwtAudience: 'infinitecontext-api',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 60 * 60 * 24 * 7,
    publicBaseUrl: 'http://127.0.0.1:8787',
};

const DB_URL = process.env.VAULT_E2E_DATABASE_URL;

function liveDatabaseUrl(): string {
    if (!DB_URL) {
        throw new Error('VAULT_E2E_DATABASE_URL is required for live vault postgres tests');
    }
    return DB_URL;
}

let postgresReady = false;

before(async () => {
    if (!DB_URL || !process.env.POSTGRES_PASSWORD) {
        postgresReady = false;
        console.warn(
            'vault-postgres-live skipped: set VAULT_E2E_DATABASE_URL and POSTGRES_PASSWORD to run live postgres tests.',
        );
        return;
    }
    postgresReady = verifyMigrationChainForDatabase(DB_URL, process.env.POSTGRES_PASSWORD);
    if (!postgresReady) {
        console.warn('vault-postgres-live skipped: migration verify failed');
        return;
    }
    const sdkRoot = path.resolve(process.cwd(), '../js-sdk');
    const build = spawnSync('pnpm', ['run', 'build'], { cwd: sdkRoot, encoding: 'utf8', timeout: 180_000 });
    if (build.status !== 0) {
        postgresReady = false;
        console.warn('vault-postgres-live skipped: js-sdk build failed\n', build.stderr || build.stdout);
    }
});

type LiveFixture = Awaited<ReturnType<typeof setupLiveApp>>;

async function setupLiveApp() {
    const config: ApiConfig = {
        DATABASE_PROVIDER: 'postgres',
        DATABASE_URL: liveDatabaseUrl(),
        INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
    };
    const storage = createStorageAdapter(config);
    const authRepo = createAuthRepository(config);
    const app = createApp({
        config,
        storage,
        authConfig: TEST_AUTH_CONFIG,
        authRepo,
        googleOAuth: createMockGoogleOAuthClient(),
        mailer: {
            async sendVerificationEmail() {},
            async sendPasswordResetEmail() {},
        },
    });

    async function json(
        method: string,
        urlPath: string,
        body?: unknown,
        token?: string,
        extraHeaders?: Record<string, string>,
    ) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
        if (token) headers.Authorization = `Bearer ${token}`;
        const init: RequestInit = { method, headers };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await app.request(`http://127.0.0.1${urlPath}`, init);
        const text = await res.text();
        return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    }

    const register = await json('POST', '/auth/register', {
        email: `vault-live-${Date.now()}@example.com`,
        password: 'password123456',
    });
    const accessToken = String(register.body.access_token ?? '');
    const me = await json('GET', '/auth/me', undefined, accessToken);

    const material = await createVaultCryptoMaterial('vault-live-pass1');
    await json(
        'PUT',
        '/auth/crypto',
        {
            kdf_salt: Buffer.from(material.kdfSalt).toString('base64'),
            kdf_params: material.kdfParams,
            wrapped_dek: Buffer.from(material.wrappedDekPassphrase).toString('base64'),
            wrapped_dek_recovery: Buffer.from(material.wrappedDekRecovery).toString('base64'),
            dek_proof: Buffer.from(computeDekProof(material.dek)).toString('base64'),
            dek_version: material.dekVersion,
            vault_passphrase_required: false,
        },
        accessToken,
    );

    const sdkRoot = path.resolve(process.cwd(), '../js-sdk');
    const { wrapInfiniteContextWithVault } = await import(path.join(sdkRoot, 'lib/encrypted-client.mjs') as string);
    const { InfiniteContext } = await import(path.join(sdkRoot, 'dist/index.mjs') as string);

    const vaultClient = wrapInfiniteContextWithVault(
        new InfiniteContext({
            baseUrl: 'http://127.0.0.1',
            accessToken,
            fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init),
        }),
        {
            dek: material.dek,
            dekVersion: 1,
            userPublicId: String(me.body.id),
        },
    );

    return { json, vaultClient, accessToken, material, userPublicId: String(me.body.id) };
}

describe('vault postgres live e2e', () => {
    it('append-by-index round-trips (daemon-style payload)', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { vaultClient } = await setupLiveApp();
        const created = await vaultClient.create({ metadata: { source: 'live-test', title: 'My Title' } });
        assert.equal(created.metadata?.title, 'My Title');
        assert.ok(!created.metadata?.decrypt_error);

        await vaultClient.append(created.id, { role: 'user', text: 'daemon payload' });
        const read = await vaultClient.get(created.id);
        assert.equal(read.data.length, 1);
        assert.ok(!read.data[0]?.decrypt_error, String(read.data[0]?.decrypt_error ?? 'no error'));
        assert.equal(read.data[0]?.text, 'daemon payload');
    });

    it('append round-trips sync daemon payload shape (nested content, no id)', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { vaultClient } = await setupLiveApp();
        const created = await vaultClient.create({ metadata: { source: 'sync-daemon-test' } });
        await vaultClient.append(created.id, {
            role: 'user',
            content: {
                message: 'nested daemon message',
                event_type: 'test.event',
                timestamp: new Date().toISOString(),
                raw: '{}',
            },
            metadata: { source: 'sync-daemon-test', event_id: 'ev_1' },
        });
        const read = await vaultClient.get(created.id);
        assert.equal(read.data.length, 1);
        assert.ok(!read.data[0]?.decrypt_error);
        const content = read.data[0]?.content as Record<string, unknown> | undefined;
        assert.equal(content?.message, 'nested daemon message');
    });

    it('detects swapped ciphertext between indices', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { vaultClient, json, accessToken } = await setupLiveApp();
        const created = await vaultClient.create({ metadata: { source: 'swap-test' } });
        await vaultClient.append(created.id, { role: 'user', text: 'first' });
        await vaultClient.append(created.id, { role: 'user', text: 'second' });
        const snap = await json('GET', `/contexts/${created.id}`, undefined, accessToken);
        const rows = (snap.body.data ?? []) as Record<string, unknown>[];
        const row0 = rows[0]!;
        const row1 = rows[1]!;

        const stableId = (row: Record<string, unknown>) =>
            String((row.metadata as Record<string, unknown>)?.ic_client_node_id ?? row.id);
        const swap = await json(
            'PATCH',
            `/contexts/${created.id}`,
            {
                updates: [
                    {
                        id: row0.id,
                        ...pickEnvelope(row1),
                        metadata: {
                            ...(row1.metadata as Record<string, unknown>),
                            ic_client_node_id: stableId(row0),
                        },
                    },
                    {
                        id: row1.id,
                        ...pickEnvelope(row0),
                        metadata: {
                            ...(row0.metadata as Record<string, unknown>),
                            ic_client_node_id: stableId(row1),
                        },
                    },
                ],
            },
            accessToken,
        );
        assert.equal(swap.res.status, 200);

        const afterSwap = await vaultClient.get(created.id);
        assert.ok(afterSwap.data[0]?.decrypt_error, 'expected decrypt failure after ciphertext swap');
        assert.ok(afterSwap.data[1]?.decrypt_error, 'expected decrypt failure after ciphertext swap');
    });

    it('fork preserves root title and message metadata', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { vaultClient } = await setupLiveApp();
        const source = await vaultClient.create({ metadata: { title: 'Fork Me', source: 'fork-test' } });
        await vaultClient.append(source.id, {
            role: 'user',
            text: 'body',
            metadata: { event_id: 'ev_fork', note: 'secret' },
        });
        assert.equal(source.metadata?.title, 'Fork Me');
        const fork = await vaultClient.create({ from: source.id, metadata: { source: 'fork-test' } });
        assert.equal(fork.metadata?.title, 'Fork Me');
        const forkRead = await vaultClient.get(fork.id);
        assert.equal(forkRead.data[0]?.metadata?.event_id, 'ev_fork');
    });

    it('delete-then-read keeps stable client node ids', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { vaultClient } = await setupLiveApp();
        const created = await vaultClient.create({ metadata: { source: 'delete-test' } });
        await vaultClient.append(created.id, { role: 'user', text: 'a' });
        await vaultClient.append(created.id, { role: 'user', text: 'b' });
        const before = await vaultClient.get(created.id);
        const keepClientNodeId = (before.data[1]?.metadata as Record<string, unknown>)?.ic_client_node_id;
        assert.ok(typeof before.sync_base_sequence === 'number', 'expected sync_base_sequence on GET before delete');
        await vaultClient.delete(created.id, 0, { base_sequence: before.sync_base_sequence });
        const after = await vaultClient.get(created.id);
        assert.equal(after.data.length, 1);
        assert.equal((after.data[0]?.metadata as Record<string, unknown>)?.ic_client_node_id, keepClientNodeId);
        assert.equal(after.data[0]?.text, 'b');
    });

    it('migrateEncryptContext converges plaintext', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { json, accessToken, vaultClient } = await setupLiveApp();
        const registerPlain = await json('POST', '/auth/register', {
            email: `plain-${Date.now()}@example.com`,
            password: 'password123456',
        });
        const plainToken = String(registerPlain.body.access_token ?? '');
        const ctx = await json('POST', '/contexts', { metadata: { source: 'migrate-live' } }, plainToken);
        const contextId = String(ctx.body.id);
        await json('POST', `/contexts/${contextId}`, { role: 'user', text: 'legacy plaintext' }, plainToken);

        const material = await createVaultCryptoMaterial('vault-live-pass2');
        await json(
            'PUT',
            '/auth/crypto',
            {
                kdf_salt: Buffer.from(material.kdfSalt).toString('base64'),
                kdf_params: material.kdfParams,
                wrapped_dek: Buffer.from(material.wrappedDekPassphrase).toString('base64'),
                wrapped_dek_recovery: Buffer.from(material.wrappedDekRecovery).toString('base64'),
                dek_proof: Buffer.from(computeDekProof(material.dek)).toString('base64'),
                dek_version: material.dekVersion,
                vault_passphrase_required: false,
            },
            plainToken,
        );

        const me = await json('GET', '/auth/me', undefined, plainToken);
        const sdkRoot = path.resolve(process.cwd(), '../js-sdk');
        const { wrapInfiniteContextWithVault } = await import(path.join(sdkRoot, 'lib/encrypted-client.mjs') as string);
        const { InfiniteContext } = await import(path.join(sdkRoot, 'dist/index.mjs') as string);
        const config: ApiConfig = {
            DATABASE_PROVIDER: 'postgres',
            DATABASE_URL: liveDatabaseUrl(),
            INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
        };
        const storage = createStorageAdapter(config);
        const authRepo = createAuthRepository(config);
        const app = createApp({
            config,
            storage,
            authConfig: TEST_AUTH_CONFIG,
            authRepo,
            googleOAuth: createMockGoogleOAuthClient(),
            mailer: {
                async sendVerificationEmail() {},
                async sendPasswordResetEmail() {},
            },
        });
        const migrator = wrapInfiniteContextWithVault(
            new InfiniteContext({
                baseUrl: 'http://127.0.0.1',
                accessToken: plainToken,
                fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init),
            }),
            { dek: material.dek, dekVersion: 1, userPublicId: String(me.body.id) },
        );
        await migrator.migrateEncryptContext(contextId);
        const after = await migrator.get(contextId);
        assert.equal(after.data[0]?.text, 'legacy plaintext');
        assert.ok(!after.data[0]?.decrypt_error);
        const hist = await json('GET', `/contexts/${contextId}?history=true`, undefined, plainToken);
        const versionCount = ((hist.body.versions ?? []) as unknown[]).length || 1;
        for (let v = 0; v < versionCount; v += 1) {
            const ver = await json('GET', `/contexts/${contextId}?version=${v}`, undefined, plainToken);
            assert.equal(ver.res.status, 200, `version ${v} should be readable`);
            const data = (ver.body.data ?? []) as Record<string, unknown>[];
            for (const row of data) {
                assert.equal(row.__ic_enc, 1, `version ${v} must not contain plaintext content`);
            }
        }
    });

    it('blocks encrypted append until migrate and allows migrate-read on legacy plaintext', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { json, material } = await setupLiveApp();
        const register = await json('POST', '/auth/register', {
            email: `legacy-append-${Date.now()}@example.com`,
            password: 'password123456',
        });
        const token = String(register.body.access_token ?? '');
        const ctx = await json('POST', '/contexts', { metadata: { source: 'legacy-append' } }, token);
        const contextId = String(ctx.body.id);
        await json('POST', `/contexts/${contextId}`, { role: 'user', text: 'legacy-plain' }, token);

        await json(
            'PUT',
            '/auth/crypto',
            {
                kdf_salt: Buffer.from(material.kdfSalt).toString('base64'),
                kdf_params: material.kdfParams,
                wrapped_dek: Buffer.from(material.wrappedDekPassphrase).toString('base64'),
                wrapped_dek_recovery: Buffer.from(material.wrappedDekRecovery).toString('base64'),
                dek_proof: Buffer.from(computeDekProof(material.dek)).toString('base64'),
                dek_version: material.dekVersion,
                vault_passphrase_required: false,
            },
            token,
        );

        const me = await json('GET', '/auth/me', undefined, token);
        const crypto = await import('@infinitecontext/crypto');
        const nodeId = crypto.generateClientNodeId();
        const aad = { contextId, userPublicId: String(me.body.id), nodePublicId: nodeId };
        const enc = {
            id: nodeId,
            ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', text: 'enc' }, aad),
            metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: nodeId }, aad),
        };

        const blocked = await json('POST', `/contexts/${contextId}`, enc, token);
        assert.equal(blocked.res.status, 409);

        const noMigrateHeader = await json('GET', `/contexts/${contextId}`, undefined, token);
        assert.equal(noMigrateHeader.res.status, 422);

        const migrateRead = await json('GET', `/contexts/${contextId}`, undefined, token, {
            'X-IC-Vault-Migrate-Read': '1',
        });
        assert.equal(migrateRead.res.status, 200);
    });

    it('concurrent duplicate icn appends return 409 not 500', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { json, vaultClient, accessToken, material, userPublicId } = await setupLiveApp();
        const created = await vaultClient.create({ metadata: { source: 'concurrent-append' } });
        const crypto = await import('@infinitecontext/crypto');
        const nodeId = crypto.generateClientNodeId();
        const aad = { contextId: created.id, userPublicId, nodePublicId: nodeId };
        const enc = {
            id: nodeId,
            ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', text: 'race' }, aad),
            metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: nodeId }, aad),
        };

        const statuses: number[] = await Promise.all(
            Array.from({ length: 12 }, () =>
                json('POST', `/contexts/${created.id}`, enc, accessToken).then((r) => r.res.status as number),
            ),
        );
        assert.equal(statuses.filter((s) => s === 201).length, 1);
        assert.ok(statuses.every((s) => s === 201 || s === 409), statuses.join(','));
        assert.ok(statuses.every((s) => Number(s) !== 500), 'concurrent appends must not 500');
    });

    it('rejects historical plaintext version reads', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { json, accessToken } = await setupLiveApp();
        const register = await json('POST', '/auth/register', {
            email: `hist-${Date.now()}@example.com`,
            password: 'password123456',
        });
        const token = String(register.body.access_token ?? '');
        const ctx = await json('POST', '/contexts', { metadata: { source: 'hist' } }, token);
        const contextId = String(ctx.body.id);
        await json('POST', `/contexts/${contextId}`, { role: 'user', text: 'plain-old' }, token);

        const material = await createVaultCryptoMaterial('vault-live-pass3');
        await json(
            'PUT',
            '/auth/crypto',
            {
                kdf_salt: Buffer.from(material.kdfSalt).toString('base64'),
                kdf_params: material.kdfParams,
                wrapped_dek: Buffer.from(material.wrappedDekPassphrase).toString('base64'),
                wrapped_dek_recovery: Buffer.from(material.wrappedDekRecovery).toString('base64'),
                dek_proof: Buffer.from(computeDekProof(material.dek)).toString('base64'),
                dek_version: material.dekVersion,
                vault_passphrase_required: false,
            },
            token,
        );

        const sdkRoot = path.resolve(process.cwd(), '../js-sdk');
        const { wrapInfiniteContextWithVault } = await import(path.join(sdkRoot, 'lib/encrypted-client.mjs') as string);
        const { InfiniteContext } = await import(path.join(sdkRoot, 'dist/index.mjs') as string);
        const config: ApiConfig = {
            DATABASE_PROVIDER: 'postgres',
            DATABASE_URL: liveDatabaseUrl(),
            INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
        };
        const storage = createStorageAdapter(config);
        const authRepo = createAuthRepository(config);
        const app = createApp({
            config,
            storage,
            authConfig: TEST_AUTH_CONFIG,
            authRepo,
            googleOAuth: createMockGoogleOAuthClient(),
            mailer: {
                async sendVerificationEmail() {},
                async sendPasswordResetEmail() {},
            },
        });
        const me = await json('GET', '/auth/me', undefined, token);
        const vaultClient = wrapInfiniteContextWithVault(
            new InfiniteContext({
                baseUrl: 'http://127.0.0.1',
                accessToken: token,
                fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init),
            }),
            { dek: material.dek, dekVersion: 1, userPublicId: String(me.body.id) },
        );
        const legacyHead = await json('GET', `/contexts/${contextId}?version=0`, undefined, token);
        assert.equal(legacyHead.res.status, 422);

        await vaultClient.append(contextId, { role: 'user', text: 'encrypted-new' });

        const after = await json('GET', `/contexts/${contextId}`, undefined, token);
        assert.equal(after.res.status, 200);
        const rows = (after.body.data ?? []) as Record<string, unknown>[];
        assert.ok(rows.length >= 2);
        for (const row of rows) {
            assert.equal(row.__ic_enc, 1);
        }
    });
});

function pickEnvelope(row: Record<string, unknown>) {
    return {
        __ic_enc: row.__ic_enc,
        kid: row.kid,
        v: row.v,
        alg: row.alg,
        nonce: row.nonce,
        ct: row.ct,
    };
}
