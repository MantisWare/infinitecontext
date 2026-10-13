import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { serve } from '@hono/node-server';
import { computeDekProof, createVaultCryptoMaterial, generateClientNodeId } from '@infinitecontext/crypto';

import { createLivePostgresApp } from './helpers/live-postgres-app';
import { verifyMigrationChainForDatabase } from './helpers/ensure-live-postgres';

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
    if (!DB_URL || !process.env.POSTGRES_PASSWORD) {
        console.warn('sync-cli-two-device skipped: missing Postgres env');
        return;
    }
    postgresReady = verifyMigrationChainForDatabase(DB_URL, process.env.POSTGRES_PASSWORD);
    if (!postgresReady) return;

    const sdkRoot = path.resolve(process.cwd(), '../js-sdk');
    execSync('pnpm run prepack', { cwd: sdkRoot, stdio: 'pipe' });
    execSync('pnpm run build', { cwd: sdkRoot, stdio: 'pipe' });
    const packLine = execSync('pnpm pack --silent', { cwd: sdkRoot, encoding: 'utf8' }).trim().split('\n').pop()!;
    const tgz = path.join(sdkRoot, packLine);
    installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-two-cli-'));
    fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'ic-e2e', private: true, type: 'module' }));
    execSync(`npm install --no-save --ignore-scripts --install-strategy=nested --legacy-peer-deps "file:${tgz}"`, {
        cwd: installRoot,
        stdio: 'pipe',
    });
    cliPath = path.join(installRoot, 'node_modules', 'infinitecontext', 'infinitecontext.mjs');

    const { app } = createLivePostgresApp();
    const port = 18787;
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

function cliEnv(home: string, extraEnv: Record<string, string> = {}) {
    return {
        ...process.env,
        HOME: home,
        INFINITECONTEXT_BASE_URL: baseUrl,
        INFINITECONTEXT_NO_UPDATE_CHECK: '1',
        ...extraEnv,
    };
}

/** Must not use execSync — the API server runs in-process and needs the event loop. */
async function runCli(home: string, args: string, extraEnv: Record<string, string> = {}) {
    const argv = args.trim().split(/\s+/).filter(Boolean);
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...argv], {
        env: cliEnv(home, extraEnv),
        encoding: 'utf8',
    });
    return stdout.trim();
}

function parseCliJson(stdout: string): Record<string, unknown> {
    const trimmed = stdout.trim();
    try {
        return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start !== -1 && end > start) {
            return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
        }
        const arrStart = trimmed.indexOf('[');
        const arrEnd = trimmed.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd > arrStart) {
            return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)) as Record<string, unknown>;
        }
        throw new Error(`CLI did not print JSON:\n${stdout.slice(0, 400)}`);
    }
}

async function runNodeScript(home: string, script: string) {
    const file = path.join(home, 'script.mjs');
    fs.writeFileSync(file, script);
    await execFileAsync(process.execPath, [file], {
        env: cliEnv(home),
        encoding: 'utf8',
    });
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

describe('sync CLI two-device e2e (postgres)', () => {
    it('plaintext: offline outbox on two homes converges without duplicates', async () => {
        if (!postgresReady) return;
        const email = `cli-plain-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-home-a-'));
        const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-home-b-'));
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

        const createRes = await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'cli-e2e', session_id: 's1' } },
                    },
                ],
            },
            auth.accessA,
        );
        const contextId = String((createRes.body.effects as any[])?.[0]?.context_id ?? '');
        assert.ok(contextId.startsWith('ctx_'));

        const m1 = generateClientNodeId();
        const m2 = generateClientNodeId();
        const m3 = generateClientNodeId();

        const queueScript = `
import { queueSyncMutation, flushSyncOutbox } from '${path.join(installRoot, 'node_modules', 'infinitecontext', 'lib', 'sync-engine.mjs')}';
import { mutationForMessageAppend } from '${path.join(installRoot, 'node_modules', 'infinitecontext', 'lib', 'sync-engine.mjs')}';
const contextId = ${JSON.stringify(contextId)};
const m1 = ${JSON.stringify(m1)};
const m2 = ${JSON.stringify(m2)};
const m3 = ${JSON.stringify(m3)};
queueSyncMutation(mutationForMessageAppend(contextId, [{ id: m1, role: 'user', content: { message: 'a' }, metadata: { ic_client_node_id: m1 } }]));
await flushSyncOutbox({ baseUrl: ${JSON.stringify(baseUrl)} });
`;
        await runNodeScript(homeA, queueScript);

        const queueB = `
import { queueSyncMutation, flushSyncOutbox } from '${path.join(installRoot, 'node_modules', 'infinitecontext', 'lib', 'sync-engine.mjs')}';
import { mutationForMessageAppend } from '${path.join(installRoot, 'node_modules', 'infinitecontext', 'lib', 'sync-engine.mjs')}';
const contextId = ${JSON.stringify(contextId)};
const m2 = ${JSON.stringify(m2)};
const m3 = ${JSON.stringify(m3)};
queueSyncMutation(mutationForMessageAppend(contextId, [{ id: m2, role: 'user', content: { message: 'b' }, metadata: { ic_client_node_id: m2 } }]));
queueSyncMutation(mutationForMessageAppend(contextId, [{ id: m3, role: 'user', content: { message: 'c' }, metadata: { ic_client_node_id: m3 } }]));
await flushSyncOutbox({ baseUrl: ${JSON.stringify(baseUrl)} });
`;
        await runNodeScript(homeB, queueB);

        await runCli(homeA, 'sync pull');
        await runCli(homeB, 'sync pull');

        const ctx = await apiJson('GET', `/contexts/${contextId}`, undefined, auth.accessA);
        const rows = (ctx.body.data as any[]) ?? [];
        assert.equal(rows.length, 3);
        const texts = rows.map((r) => r.content?.message ?? r.message);
        assert.deepEqual(texts, ['a', 'b', 'c']);
    });

    it('vault: encrypted appends converge on pull for two homes', async () => {
        if (!postgresReady) return;
        const email = `cli-vault-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const material = await createVaultCryptoMaterial('vault-e2e-pass1');
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

        const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-vhome-a-'));
        const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-vhome-b-'));
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
                        payload: { metadata: { source: 'vault', session_id: 'v1' } },
                    },
                ],
            },
            auth.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const crypto = await import('@infinitecontext/crypto');
        const n1 = generateClientNodeId();
        const n2 = generateClientNodeId();
        const aad1 = { contextId, userPublicId, nodePublicId: n1 };
        const enc1 = {
            id: n1,
            ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', message: 'v1' }, aad1),
            metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: n1, source: 'vault' }, aad1),
        };
        const aad2 = { contextId, userPublicId, nodePublicId: n2 };
        const enc2 = {
            id: n2,
            ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', message: 'v2' }, aad2),
            metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: n2, source: 'vault' }, aad2),
        };
        await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    { client_id: n1, op: 'message_append', context_id: contextId, payload: { messages: [enc1] } },
                    { client_id: n2, op: 'message_append', context_id: contextId, payload: { messages: [enc2] } },
                ],
            },
            auth.accessA,
        );

        await runCli(homeB, 'sync pull');
        const status = parseCliJson(await runCli(homeB, 'sync status'));
        assert.ok(Number(status.head_sequence) >= 3);
    });

    it('revoked device refresh fails after sync devices revoke', async () => {
        if (!postgresReady) return;
        const email = `cli-revoke-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-revoke-a-'));
        writeCredentials(homeA, {
            accessToken: auth.accessA,
            refreshToken: auth.refreshA,
            accessTokenExpiresAt: auth.accessExpiresA,
            refreshTokenExpiresAt: auth.refreshExpiresA,
        });
        const devicesJson = parseCliJson(await runCli(homeA, 'sync devices'));
        const target = (devicesJson.data as any[]).find((d) => d.device_id === 'dev-b');
        assert.ok(target?.id);
        await runCli(homeA, `sync devices revoke ${target.id}`);
        const refresh = await apiJson('POST', '/auth/refresh', { refresh_token: auth.refreshB });
        assert.equal(refresh.res.status, 401);
    });
});
