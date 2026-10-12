import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { serve } from '@hono/node-server';
import { DatabaseSync } from 'node:sqlite';
import { computeDekProof, createVaultCryptoMaterial, generateClientNodeId } from '@infinitecontext/crypto';

import { createLivePostgresApp } from './helpers/live-postgres-app';
import { verifyMigrationChainForDatabase } from './helpers/ensure-live-postgres';

const execFileAsync = promisify(execFile);

const DB_URL = process.env.SYNC_E2E_DATABASE_URL ?? process.env.VAULT_E2E_DATABASE_URL;
let postgresReady = false;
let server: ReturnType<typeof serve> | null = null;
let baseUrl = '';
let cliPath = '';
let installRoot = '';
let apiJson: (
    method: string,
    urlPath: string,
    body?: unknown,
    token?: string,
) => Promise<{ res: Response; body: Record<string, unknown> }>;

before(async () => {
    if (!DB_URL || !process.env.POSTGRES_PASSWORD) return;
    postgresReady = verifyMigrationChainForDatabase(DB_URL, process.env.POSTGRES_PASSWORD);
    if (!postgresReady) return;

    const sdkRoot = path.resolve(process.cwd(), '../js-sdk');
    execSync('pnpm run prepack', { cwd: sdkRoot, stdio: 'pipe' });
    execSync('pnpm run build', { cwd: sdkRoot, stdio: 'pipe' });
    const packLine = execSync('pnpm pack --silent', { cwd: sdkRoot, encoding: 'utf8' }).trim().split('\n').pop()!;
    const tgz = path.join(sdkRoot, packLine);
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-daemon-cli-'));
    fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'ic-daemon-e2e', private: true, type: 'module' }));
    execSync(`npm install --no-save --ignore-scripts --install-strategy=nested --legacy-peer-deps "file:${tgz}"`, {
        cwd: installRoot,
        stdio: 'pipe',
    });
    cliPath = path.join(installRoot, 'node_modules', 'infinitecontext', 'infinitecontext.mjs');

    const { app } = createLivePostgresApp();
    const port = 18786;
    baseUrl = `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, port }, () => resolve());
    });

    apiJson = async (method, urlPath, body, token) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const init: RequestInit = { method, headers };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await fetch(`${baseUrl}${urlPath}`, init);
        const text = await res.text();
        return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    };
});

after(() => {
    server?.close?.();
});

function writeCredentials(home: string, creds: Record<string, unknown>) {
    const dir = path.join(home, '.infinitecontext');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
        path.join(dir, 'credentials.json'),
        `${JSON.stringify({ version: 1, baseUrl, ...creds }, null, 2)}\n`,
        { mode: 0o600 },
    );
}

function cliEnv(home: string, dbFile: string, extra: Record<string, string> = {}) {
    return {
        ...process.env,
        HOME: home,
        INFINITECONTEXT_BASE_URL: baseUrl,
        INFINITECONTEXT_NO_UPDATE_CHECK: '1',
        INFINITECONTEXT_POLL_MS: '250',
        INFINITECONTEXT_DB_FILE: dbFile,
        ...extra,
    };
}

async function authPair(email: string) {
    const reg = await apiJson('POST', '/auth/register', {
        email,
        password: 'password123456',
        device_id: 'dev-a',
        device_name: 'A',
    });
    const loginB = await apiJson('POST', '/auth/login', {
        email,
        password: 'password123456',
        device_id: 'dev-b',
        device_name: 'B',
    });
    return {
        accessA: String(reg.body.access_token),
        refreshA: String(reg.body.refresh_token),
        accessExpiresA: String(reg.body.expires_at),
        refreshExpiresA: String(reg.body.refresh_expires_at),
        accessB: String(loginB.body.access_token),
        refreshB: String(loginB.body.refresh_token),
        accessExpiresB: String(loginB.body.expires_at),
        refreshExpiresB: String(loginB.body.refresh_expires_at),
    };
}

async function ensureDaemonDb(dbFile: string) {
    const storePath = path.resolve(process.cwd(), '../sync/src/store.mjs');
    const { createStore } = await import(storePath);
    createStore({ dbPath: dbFile }).close();
}

async function runDaemonCycle(home: string, dbFile: string) {
    await ensureDaemonDb(dbFile);
    const child = spawn(process.execPath, [cliPath, 'sync', 'start'], {
        env: cliEnv(home, dbFile),
        stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 4000));
    try {
        await execFileAsync(process.execPath, [cliPath, 'sync', 'stop'], { env: cliEnv(home, dbFile) });
    } catch {
        child.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 300));
}

function countDaemonMessages(dbFile: string): number {
    const db = new DatabaseSync(dbFile);
    const row = db.prepare('SELECT COUNT(*) AS c FROM sync_message_nodes').get();
    db.close();
    return Number((row as { c: number }).c ?? 0);
}

async function unlockVaultInHome(home: string, passphrase: string) {
    const lib = path.join(installRoot, 'node_modules', 'infinitecontext', 'lib');
    const script = `
import { getVaultContext, unlockVaultWithPassphrase } from '${path.join(lib, 'vault-session.mjs')}';
const ctx = await getVaultContext({ baseUrl: ${JSON.stringify(baseUrl)} });
await unlockVaultWithPassphrase({ baseUrl: ${JSON.stringify(baseUrl)}, passphrase: ${JSON.stringify(passphrase)}, accountKey: ctx.accountKey, crypto: ctx.crypto });
`;
    const file = path.join(home, 'unlock.mjs');
    fs.writeFileSync(file, script);
    await execFileAsync(process.execPath, [file], { env: cliEnv(home, path.join(home, 'daemon.db')) });
}

async function queueOfflineAppend(home: string, contextId: string, message: string, clientId: string) {
    const enginePath = path.join(installRoot, 'node_modules', 'infinitecontext', 'lib', 'sync-engine.mjs');
    const script = `
import { queueSyncMutation, mutationForMessageAppend } from '${enginePath}';
const contextId = ${JSON.stringify(contextId)};
const clientId = ${JSON.stringify(clientId)};
queueSyncMutation(mutationForMessageAppend(contextId, [{
  id: clientId,
  role: 'user',
  content: { message: ${JSON.stringify(message)} },
  metadata: { ic_client_node_id: clientId },
}]));
`;
    const file = path.join(home, 'queue.mjs');
    fs.writeFileSync(file, script);
    await execFileAsync(process.execPath, [file], { env: cliEnv(home, path.join(home, 'daemon.db')) });
}

describe('sync daemon two-device e2e (postgres)', () => {
    it('plaintext: daemon pull/push converges offline appends on two homes', async () => {
        if (!postgresReady) return;
        const email = `daemon-plain-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-daemon-a-'));
        const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-daemon-b-'));
        const dbA = path.join(homeA, 'daemon.db');
        const dbB = path.join(homeB, 'daemon.db');
        writeCredentials(homeA, {
            accessToken: auth.accessA,
            refreshToken: auth.refreshA,
            accessTokenExpiresAt: auth.accessExpiresA,
            refreshTokenExpiresAt: auth.refreshExpiresA,
        });
        writeCredentials(homeB, {
            accessToken: auth.accessB,
            refreshToken: auth.refreshB,
            accessTokenExpiresAt: auth.accessExpiresB,
            refreshTokenExpiresAt: auth.refreshExpiresB,
        });

        const create = await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'daemon-e2e', session_id: 'd1' } },
                    },
                ],
            },
            auth.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');

        const m1 = generateClientNodeId();
        const m2 = generateClientNodeId();
        const m3 = generateClientNodeId();
        await queueOfflineAppend(homeA, contextId, 'a', m1);
        await queueOfflineAppend(homeB, contextId, 'b', m2);
        await queueOfflineAppend(homeB, contextId, 'c', m3);

        await runDaemonCycle(homeA, dbA);
        await runDaemonCycle(homeB, dbB);
        await runDaemonCycle(homeA, dbA);

        const ctx = await apiJson('GET', `/contexts/${contextId}`, undefined, auth.accessA);
        assert.equal(((ctx.body.data as any[]) ?? []).length, 3);
        assert.ok(countDaemonMessages(dbA) >= 3);
        assert.ok(countDaemonMessages(dbB) >= 3);
    });

    it('vault: daemon pull records encrypted replica rows (no plaintext in sqlite)', async () => {
        if (!postgresReady) return;
        const email = `daemon-vault-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const material = await createVaultCryptoMaterial('vault-daemon-pass1');
        await apiJson(
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
            auth.accessA,
        );
        const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-daemon-vb-'));
        const dbB = path.join(homeB, 'daemon.db');
        writeCredentials(homeB, {
            accessToken: auth.accessB,
            refreshToken: auth.refreshB,
            accessTokenExpiresAt: auth.accessExpiresB,
            refreshTokenExpiresAt: auth.refreshExpiresB,
        });

        const me = await apiJson('GET', '/auth/me', undefined, auth.accessA);
        const userPublicId = String(me.body.id);
        const create = await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'vault-daemon', session_id: 'vd1' } },
                    },
                ],
            },
            auth.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const crypto = await import('@infinitecontext/crypto');
        const n1 = generateClientNodeId();
        const aad = { contextId, userPublicId, nodePublicId: n1 };
        const enc = {
            id: n1,
            ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', message: 'secret' }, aad),
            metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: n1, source: 'vault' }, aad),
        };
        await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [{ client_id: n1, op: 'message_append', context_id: contextId, payload: { messages: [enc] } }],
            },
            auth.accessA,
        );

        await unlockVaultInHome(homeB, 'vault-daemon-pass1');
        await runDaemonCycle(homeB, dbB);
        await runDaemonCycle(homeB, dbB);
        const db = new DatabaseSync(dbB);
        const rows = db.prepare('SELECT payload_json FROM sync_message_nodes').all();
        db.close();
        assert.ok(rows.length >= 1, `expected daemon replica rows, got ${rows.length}`);
        const blob = JSON.stringify(rows);
        assert.ok(!blob.includes('"message":"secret"'), 'daemon replica must not contain decrypted plaintext');
        assert.ok(blob.includes('__ic_enc') || blob.includes('ciphertext'));
    });
});
