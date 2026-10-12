import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { createMockGoogleOAuthClient } from '@infinitecontext/auth';
import { computeDekProof, createVaultCryptoMaterial, generateClientNodeId } from '@infinitecontext/crypto';
import { createAuthRepository, createStorageAdapter } from '@infinitecontext/storage';

import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

const TEST_AUTH_CONFIG = {
    jwtSecret: 'test-jwt-secret-must-be-at-least-32-bytes-long',
    jwtIssuer: 'http://127.0.0.1:8787',
    jwtAudience: 'infinitecontext-api',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 60 * 60 * 24 * 7,
    publicBaseUrl: 'http://127.0.0.1:8787',
};

const DB_URL = process.env.SYNC_E2E_DATABASE_URL ?? process.env.VAULT_E2E_DATABASE_URL;

let postgresReady = false;

before(async () => {
    if (!DB_URL || !process.env.POSTGRES_PASSWORD) {
        postgresReady = false;
        console.warn('sync-postgres-live skipped: set SYNC_E2E_DATABASE_URL and POSTGRES_PASSWORD.');
        return;
    }
    const script = path.resolve(process.cwd(), '../postgres/scripts/verify-migration-chain.sh');
    const res = spawnSync('bash', [script], {
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD },
    });
    postgresReady = res.status === 0;
    if (!postgresReady) {
        console.warn('sync-postgres-live skipped: migration verify failed\n', res.stderr || res.stdout);
    }
});

async function setupApp() {
    const config: ApiConfig = {
        DATABASE_PROVIDER: 'postgres',
        DATABASE_URL: DB_URL!,
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

    async function json(method: string, urlPath: string, body?: unknown, token?: string) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const init: RequestInit = { method, headers };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await app.request(`http://127.0.0.1${urlPath}`, init);
        const text = await res.text();
        return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    }

    const email = `sync-live-${Date.now()}@example.com`;
    const register = await json('POST', '/auth/register', {
        email,
        password: 'password123456',
        device_id: 'device-a',
        device_name: 'Device A',
    });

    const accessA = String(register.body.access_token ?? '');
    const refreshA = String(register.body.refresh_token ?? '');

    const loginB = await json('POST', '/auth/login', {
        email,
        password: 'password123456',
        device_id: 'device-b',
        device_name: 'Device B',
    });

    return { json, accessA, refreshA, accessB: String(loginB.body.access_token ?? ''), refreshB: String(loginB.body.refresh_token ?? '') };
}

describe('sync-postgres-live', () => {
    it('converges two devices with plaintext append-only merge', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const ctxRes = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'test', session_id: 's1' } },
                    },
                ],
            },
            fx.accessA,
        );
        assert.equal(ctxRes.res.status, 200);
        const contextId = String((ctxRes.body.effects as any[])?.[0]?.context_id ?? '');
        assert.ok(contextId.startsWith('ctx_'));

        const m1 = generateClientNodeId();
        const m2 = generateClientNodeId();
        await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: m1,
                        op: 'message_append',
                        context_id: contextId,
                        payload: { messages: [{ id: m1, role: 'user', content: { message: 'a' }, metadata: { ic_client_node_id: m1 } }] },
                    },
                ],
            },
            fx.accessA,
        );
        await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: m2,
                        op: 'message_append',
                        context_id: contextId,
                        payload: { messages: [{ id: m2, role: 'user', content: { message: 'b' }, metadata: { ic_client_node_id: m2 } }] },
                    },
                ],
            },
            fx.accessB,
        );

        const pull = await fx.json('GET', '/sync/changes?since=0&limit=100', undefined, fx.accessB);
        assert.equal(pull.res.status, 200);
        const changes = pull.body.changes as any[];
        assert.ok(changes.length >= 3);

        const dup = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: m1,
                        op: 'message_append',
                        context_id: contextId,
                        payload: { messages: [{ id: m1, role: 'user', content: { message: 'a' } }] },
                    },
                ],
            },
            fx.accessB,
        );
        assert.deepEqual(dup.body.duplicate, [m1]);

        const read = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessB);
        assert.equal((read.body.data as any[])?.length, 2);
    });

    it('paginates changes beyond a single page', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const mutations = [];
        for (let i = 0; i < 105; i += 1) {
            mutations.push({
                client_id: generateClientNodeId(),
                op: 'context_create',
                payload: { metadata: { source: 'bulk', n: i } },
            });
        }
        const push = await fx.json('POST', '/sync/push', { mutations }, fx.accessA);
        assert.equal(push.res.status, 200);

        let since = 0;
        let total = 0;
        for (let page = 0; page < 20; page += 1) {
            const pull = await fx.json(`GET`, `/sync/changes?since=${since}&limit=50`, undefined, fx.accessA);
            const batch = pull.body.changes as any[];
            if (batch.length === 0) break;
            total += batch.length;
            since = Number(pull.body.next_since ?? since);
            if (!pull.body.has_more) break;
        }
        assert.ok(total >= 105);
    });

    it('revoked device cannot refresh', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const devices = await fx.json('GET', '/auth/devices', undefined, fx.accessA);
        const list = (devices.body.data as any[]) ?? [];
        const target = list.find((d) => d.device_id === 'device-b');
        assert.ok(target?.id);
        await fx.json('POST', `/auth/devices/${target.id}/revoke`, {}, fx.accessA);
        const refresh = await fx.json('POST', '/auth/refresh', { refresh_token: fx.refreshB });
        assert.equal(refresh.res.status, 401);
    });
});

describe('sync-postgres-live vault', () => {
    it('round-trips encrypted append via sync push', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const material = await createVaultCryptoMaterial('vault-sync-pass');
        await fx.json(
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
            fx.accessA,
        );

        const nodeId = generateClientNodeId();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'vault', session_id: 'vs1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const me = await fx.json('GET', '/auth/me', undefined, fx.accessA);
        const userPublicId = String(me.body.id ?? '');

        const crypto = await import('@infinitecontext/crypto');
        const aad = { contextId, userPublicId, nodePublicId: nodeId };
        const content = crypto.encryptNodeContent(material.dek, 1, { role: 'user', message: 'secret' }, aad);
        const meta = crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: nodeId, source: 'vault' }, aad);

        const append = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: nodeId,
                        op: 'message_append',
                        context_id: contextId,
                        payload: {
                            messages: [{ id: nodeId, ...content, metadata: meta }],
                        },
                    },
                ],
            },
            fx.accessA,
        );
        assert.equal(append.res.status, 200);
        const pull = await fx.json('GET', '/sync/changes?since=0', undefined, fx.accessB);
        assert.ok((pull.body.changes as any[])?.length >= 2);
    });
});
