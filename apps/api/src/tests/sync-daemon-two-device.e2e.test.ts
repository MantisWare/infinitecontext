import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execSync, spawn, type ChildProcess } from 'node:child_process';
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
/** @type {Set<string>} */
let vaultAgentPidsBaseline = new Set();
/** @type {Set<string>} */
const trackedVaultAgentPids = new Set();

/** @type {ChildProcess[]} */
const trackedDaemonChildren: ChildProcess[] = [];
/** @type {string[]} */
const trackedTempHomes: string[] = [];

function snapshotVaultAgentPids() {
    try {
        const out = execSync('pgrep -f "[v]ault-agent-serve.mjs" || true', { encoding: 'utf8' }).trim();
        if (!out) return new Set<string>();
        return new Set(out.split('\n').filter(Boolean));
    } catch {
        return new Set<string>();
    }
}

function readLinuxPpid(pid: number): number | null {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const match = stat.match(/^\d+ \([^)]+\) [A-Z] (\d+)/);
        return match ? Number(match[1]) : null;
    } catch {
        return null;
    }
}

function isDescendantOf(pid: number, ancestorPid: number): boolean {
    let current = pid;
    for (let depth = 0; depth < 64; depth += 1) {
        if (current === ancestorPid) return true;
        const ppid = readLinuxPpid(current);
        if (!ppid || ppid <= 1) return false;
        current = ppid;
    }
    return false;
}

function registerVaultAgentsSpawnedByTrackedDaemons(tempHomes: string[] = trackedTempHomes) {
    const daemonPids = trackedDaemonChildren
        .map((child) => child.pid)
        .filter((pid): pid is number => typeof pid === 'number' && pid > 0);
    const after = snapshotVaultAgentPids();
    for (const pid of after) {
        if (vaultAgentPidsBaseline.has(pid)) continue;
        const numeric = Number(pid);
        if (!numeric) continue;
        if (daemonPids.some((daemonPid) => isDescendantOf(numeric, daemonPid))) {
            trackedVaultAgentPids.add(pid);
            continue;
        }
        try {
            const cmdline = fs.readFileSync(`/proc/${numeric}/cmdline`, 'utf8');
            if (tempHomes.some((home) => cmdline.includes(home))) {
                trackedVaultAgentPids.add(pid);
            }
        } catch {
            /* process exited */
        }
    }
}

function shutdownVaultAgentsForHomes(homes: string[]) {
    for (const home of homes) {
        const pidFile = path.join(home, '.infinitecontext', 'vault-agent.pid');
        try {
            const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            if (Number.isInteger(pid) && pid > 0) {
                trackedVaultAgentPids.add(String(pid));
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {
                    /* ignore */
                }
            }
        } catch {
            /* no pid file */
        }
    }
}

async function terminateTrackedVaultAgents() {
    registerVaultAgentsSpawnedByTrackedDaemons();
    for (const pid of trackedVaultAgentPids) {
        if (vaultAgentPidsBaseline.has(pid)) continue;
        try {
            process.kill(Number(pid), 'SIGTERM');
        } catch {
            /* ignore */
        }
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const pid of [...trackedVaultAgentPids]) {
        if (vaultAgentPidsBaseline.has(pid)) continue;
        try {
            process.kill(Number(pid), 'SIGKILL');
        } catch {
            /* ignore */
        }
    }
    trackedVaultAgentPids.clear();
}

function trackTempHome(prefix: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    trackedTempHomes.push(dir);
    return dir;
}

function spawnDaemonStart(env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, [cliPath, 'sync', 'start'], {
        env,
        stdio: 'ignore',
    });
    trackedDaemonChildren.push(child);
    return child;
}

async function terminateTrackedChild(child: ChildProcess) {
    if (!child.pid || child.exitCode !== null) return;
    try {
        child.kill('SIGTERM');
    } catch {
        /* exited */
    }
    await Promise.race([
        new Promise<void>((resolve) => {
            if (child.exitCode !== null) {
                resolve();
                return;
            }
            child.once('exit', () => resolve());
        }),
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null && child.pid) {
        try {
            child.kill('SIGKILL');
        } catch {
            /* ignore */
        }
    }
}

async function cleanupDaemonLeaks() {
    for (const child of trackedDaemonChildren.splice(0)) {
        await terminateTrackedChild(child);
    }
    for (const home of trackedTempHomes.splice(0)) {
        try {
            fs.rmSync(home, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
}

function vaultAgentPidsScopedToTrackedHomes(): Set<string> {
    const scoped = new Set<string>();
    for (const pid of snapshotVaultAgentPids()) {
        if (vaultAgentPidsBaseline.has(pid)) {
            continue;
        }
        const numeric = Number(pid);
        if (!numeric) {
            continue;
        }
        if (trackedVaultAgentPids.has(pid)) {
            scoped.add(pid);
            continue;
        }
        try {
            const cmdline = fs.readFileSync(`/proc/${numeric}/cmdline`, 'utf8');
            if (trackedTempHomes.some((home) => cmdline.includes(home))) {
                scoped.add(pid);
            }
        } catch {
            /* exited */
        }
    }
    return scoped;
}

function assertNoDaemonLeaksAfterCleanup() {
    const scoped = vaultAgentPidsScopedToTrackedHomes();
    assert.equal(
        scoped.size,
        0,
        `vault-agent-serve.mjs still running for this test's temp homes: ${[...scoped].join(', ')}`,
    );
}
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
    vaultAgentPidsBaseline = snapshotVaultAgentPids();

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

async function shutdownDaemonE2e(exitCode = 0) {
    await cleanupDaemonLeaks();
    await terminateTrackedVaultAgents();
    server?.close?.();
    if (installRoot && fs.existsSync(installRoot)) {
        fs.rmSync(installRoot, { recursive: true, force: true });
    }
    if (exitCode !== 0) {
        process.exit(exitCode);
    }
}

process.on('SIGINT', () => {
    void shutdownDaemonE2e(130);
});
process.on('SIGTERM', () => {
    void shutdownDaemonE2e(143);
});

after(async () => {
    await shutdownDaemonE2e(0);
});

describe('sync daemon two-device e2e (postgres)', () => {
    afterEach(async () => {
        const tempHomes = [...trackedTempHomes];
        shutdownVaultAgentsForHomes(tempHomes);
        registerVaultAgentsSpawnedByTrackedDaemons(tempHomes);
        await cleanupDaemonLeaks();
        await terminateTrackedVaultAgents();
        assertNoDaemonLeaksAfterCleanup();
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
    const child = spawnDaemonStart(cliEnv(home, dbFile));
    await new Promise((r) => setTimeout(r, 4000));
    try {
        await execFileAsync(process.execPath, [cliPath, 'sync', 'stop'], { env: cliEnv(home, dbFile) });
    } catch {
        child.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 300));
}

function countDaemonMessages(dbFile: string, contextId?: string): number {
    const db = new DatabaseSync(dbFile);
    const row = contextId
        ? db.prepare('SELECT COUNT(*) AS c FROM sync_message_nodes WHERE context_id = ?').get(contextId)
        : db.prepare('SELECT COUNT(*) AS c FROM sync_message_nodes').get();
    db.close();
    return Number((row as { c: number }).c ?? 0);
}

async function setupVaultCrypto(accessA: string) {
    const material = await createVaultCryptoMaterial('vault-daemon-e2e-pass');
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
        accessA,
    );
    return material;
}

async function createVaultContext(accessA: string, material: Awaited<ReturnType<typeof createVaultCryptoMaterial>>, sessionId: string) {
    const create = await apiJson(
        'POST',
        '/sync/push',
        {
            mutations: [
                {
                    client_id: generateClientNodeId(),
                    op: 'context_create',
                    payload: { metadata: { source: 'vault-daemon-e2e', session_id: sessionId } },
                },
            ],
        },
        accessA,
    );
    const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
    const me = await apiJson('GET', '/auth/me', undefined, accessA);
    const userPublicId = String(me.body.id);
    return { contextId, userPublicId };
}

async function appendVaultPlaintextMessages(
    access: string,
    material: Awaited<ReturnType<typeof createVaultCryptoMaterial>>,
    contextId: string,
    userPublicId: string,
    entries: Array<{ clientId: string; message: string }>,
) {
    const crypto = await import('@infinitecontext/crypto');
    const messages = entries.map(({ clientId, message }) => {
        const aad = { contextId, userPublicId, nodePublicId: clientId };
        return {
            id: clientId,
            ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', message }, aad),
            metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: clientId, source: 'vault' }, aad),
        };
    });
    await apiJson(
        'POST',
        '/sync/push',
        {
            mutations: entries.map(({ clientId }) => ({
                client_id: clientId,
                op: 'message_append',
                context_id: contextId,
                payload: { messages: messages.filter((m) => m.id === clientId) },
            })),
        },
        access,
    );
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

    it('plaintext: daemon pull/push converges offline appends on two homes', async () => {
        if (!postgresReady) return;
        const email = `daemon-plain-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const homeA = trackTempHome('ic-daemon-a-');
        const homeB = trackTempHome('ic-daemon-b-');
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
        const homeB = trackTempHome('ic-daemon-vb-');
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

    it('vault: delete stale base conflicts; replica matches server after delete', async () => {
        if (!postgresReady) return;
        const email = `daemon-vdel-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const material = await setupVaultCrypto(auth.accessA);
        const homeA = trackTempHome('ic-vdel-a-');
        const homeB = trackTempHome('ic-vdel-b-');
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
        await unlockVaultInHome(homeA, 'vault-daemon-e2e-pass');
        await unlockVaultInHome(homeB, 'vault-daemon-e2e-pass');

        const { contextId } = await createVaultContext(auth.accessA, material, 'vdel1');
        const m1 = generateClientNodeId();
        const m2 = generateClientNodeId();
        await appendVaultPlaintextMessages(auth.accessA, material, contextId, String((await apiJson('GET', '/auth/me', undefined, auth.accessA)).body.id), [
            { clientId: m1, message: 'one' },
            { clientId: m2, message: 'two' },
        ]);

        const statusBefore = await apiJson('GET', '/sync/status', undefined, auth.accessA);
        const baseSeq = Number(statusBefore.body.head_sequence ?? 0);

        const crypto = await import('@infinitecontext/crypto');
        const userPublicId = String((await apiJson('GET', '/auth/me', undefined, auth.accessA)).body.id);
        const aad = { contextId, userPublicId, nodePublicId: m1 };
        const encUpd = {
            id: m1,
            ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', message: 'one edited' }, aad),
            metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: m1, source: 'vault' }, aad),
        };
        await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_update',
                        context_id: contextId,
                        payload: { updates: [encUpd] },
                    },
                ],
            },
            auth.accessA,
        );

        const delAttempt = await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_delete',
                        context_id: contextId,
                        base_sequence: baseSeq,
                        payload: { ids: [m1] },
                    },
                ],
            },
            auth.accessB,
        );
        const conflictKinds = (delAttempt.body.conflicts as any[])?.map((c) => c.kind) ?? [];
        assert.ok(conflictKinds.includes('delete_stale_base'));

        const headBeforeDel = await apiJson('GET', '/sync/status', undefined, auth.accessA);
        await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_delete',
                        context_id: contextId,
                        base_sequence: Number(headBeforeDel.body.head_sequence ?? 0),
                        payload: { ids: [m2] },
                    },
                ],
            },
            auth.accessA,
        );

        await runDaemonCycle(homeA, dbA);
        await runDaemonCycle(homeB, dbB);

        const read = await apiJson('GET', `/contexts/${contextId}`, undefined, auth.accessA);
        const serverCount = ((read.body.data as any[]) ?? []).length;
        assert.equal(countDaemonMessages(dbA, contextId), serverCount);
        assert.equal(countDaemonMessages(dbB, contextId), serverCount);
    });

    it('vault: update on different message after delete is not context_deleted', async () => {
        if (!postgresReady) return;
        const email = `daemon-vupd-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const material = await setupVaultCrypto(auth.accessA);
        const homeA = trackTempHome('ic-vupd-a-');
        const dbA = path.join(homeA, 'daemon.db');
        writeCredentials(homeA, {
            accessToken: auth.accessA,
            refreshToken: auth.refreshA,
            accessTokenExpiresAt: auth.accessExpiresA,
            refreshTokenExpiresAt: auth.refreshExpiresA,
        });
        await unlockVaultInHome(homeA, 'vault-daemon-e2e-pass');

        const me = await apiJson('GET', '/auth/me', undefined, auth.accessA);
        const userPublicId = String(me.body.id);
        const { contextId } = await createVaultContext(auth.accessA, material, 'vupd1');
        const m1 = generateClientNodeId();
        const m2 = generateClientNodeId();
        await appendVaultPlaintextMessages(auth.accessA, material, contextId, userPublicId, [
            { clientId: m1, message: 'drop' },
            { clientId: m2, message: 'stay' },
        ]);

        const headBeforeDel = await apiJson('GET', '/sync/status', undefined, auth.accessA);
        await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [{
                    client_id: generateClientNodeId(),
                    op: 'message_delete',
                    context_id: contextId,
                    base_sequence: Number(headBeforeDel.body.head_sequence ?? 0),
                    payload: { ids: [m1] },
                }],
            },
            auth.accessB,
        );

        const crypto = await import('@infinitecontext/crypto');
        const aad = { contextId, userPublicId, nodePublicId: m2 };
        const encUpd = {
            id: m2,
            ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', message: 'stay edited' }, aad),
            metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: m2, source: 'vault' }, aad),
        };
        const upd = await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    { client_id: generateClientNodeId(), op: 'message_update', context_id: contextId, payload: { updates: [encUpd] } },
                ],
            },
            auth.accessA,
        );
        const failedCodes = (upd.body.failed as any[])?.map((f) => f.code) ?? [];
        assert.ok(!failedCodes.includes('context_deleted'));

        await runDaemonCycle(homeA, dbA);
        const read = await apiJson('GET', `/contexts/${contextId}`, undefined, auth.accessA);
        assert.equal(((read.body.data as any[]) ?? []).length, 1);
    });

    it('vault: contexts_delete_many via sync push', async () => {
        if (!postgresReady) return;
        const email = `daemon-vbulk-${Date.now()}@example.com`;
        const auth = await authPair(email);
        await setupVaultCrypto(auth.accessA);
        const c1 = generateClientNodeId();
        const c2 = generateClientNodeId();
        const create = await apiJson(
            'POST',
            '/sync/push',
            {
                mutations: [
                    { client_id: c1, op: 'context_create', payload: { metadata: { source: 'vbulk', n: 1 } } },
                    { client_id: c2, op: 'context_create', payload: { metadata: { source: 'vbulk', n: 2 } } },
                ],
            },
            auth.accessA,
        );
        const ctx1 = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const ctx2 = String((create.body.effects as any[])?.[1]?.context_id ?? '');
        const delMany = await apiJson(
            'POST',
            '/sync/push',
            { mutations: [{ client_id: generateClientNodeId(), op: 'contexts_delete_many', payload: { ids: [ctx1, ctx2] } }] },
            auth.accessA,
        );
        assert.equal(delMany.res.status, 200, JSON.stringify(delMany.body));
    });

    it('plaintext: offline codex lines push after reconnect', async () => {
        if (!postgresReady) return;
        const email = `daemon-offline-${Date.now()}@example.com`;
        const auth = await authPair(email);
        const home = trackTempHome('ic-daemon-offline-');
        const dbFile = path.join(home, 'daemon.db');
        writeCredentials(home, {
            accessToken: auth.accessA,
            refreshToken: auth.refreshA,
            accessTokenExpiresAt: auth.accessExpiresA,
            refreshTokenExpiresAt: auth.refreshExpiresA,
        });

        const sessionDir = path.join(home, '.codex', 'sessions');
        fs.mkdirSync(sessionDir, { recursive: true });
        const sessionFile = path.join(sessionDir, 'offline-e2e.jsonl');
        const sessionId = 'offline-e2e';
        const lines = [
            JSON.stringify({
                timestamp: new Date().toISOString(),
                type: 'session_meta',
                payload: { id: sessionId, cwd: '/tmp/offline-e2e' },
            }),
            JSON.stringify({
                timestamp: new Date().toISOString(),
                type: 'event_msg',
                payload: { type: 'user_message', message: 'offline daemon line unique marker xyzzy' },
            }),
        ];
        fs.writeFileSync(sessionFile, `${lines.join('\n')}\n`, 'utf8');

        const codexGlob = sessionFile;
        const ingestEnv = {
            CODEX_GLOB: codexGlob,
            CAPTURE_AGENTS: 'codex',
            INGEST_CLAUDE: 'false',
            INGEST_CURSOR: 'false',
            INGEST_OPENCLAW: 'false',
            INGEST_GEMINI: 'false',
            INGEST_GSTACK: 'false',
            INGEST_CODEX: 'true',
            DAEMON_BOOTSTRAP_MODE: 'all',
            DAEMON_BOOTSTRAP_RESET: 'true',
        };
        const offlineEnv = {
            ...cliEnv(home, dbFile, {
                ...ingestEnv,
                INFINITECONTEXT_BASE_URL: 'http://127.0.0.1:9',
            }),
        };

        await ensureDaemonDb(dbFile);
        const offlineChild = spawnDaemonStart(offlineEnv);
        await new Promise((r) => setTimeout(r, 4500));
        try {
            await execFileAsync(process.execPath, [cliPath, 'sync', 'stop'], { env: offlineEnv });
        } catch {
            offlineChild.kill('SIGTERM');
        }
        await new Promise((r) => setTimeout(r, 300));

        const contextsBefore = await apiJson('GET', '/contexts?limit=50', undefined, auth.accessA);
        const beforeCount = ((contextsBefore.body.data as any[]) ?? []).length;

        await ensureDaemonDb(dbFile);
        const onlineChild = spawnDaemonStart(cliEnv(home, dbFile, ingestEnv));
        await new Promise((r) => setTimeout(r, 8000));
        try {
            await execFileAsync(process.execPath, [cliPath, 'sync', 'stop'], { env: cliEnv(home, dbFile, ingestEnv) });
        } catch {
            onlineChild.kill('SIGTERM');
        }
        await new Promise((r) => setTimeout(r, 300));
        await ensureDaemonDb(dbFile);
        const onlineChild2 = spawnDaemonStart(cliEnv(home, dbFile, ingestEnv));
        await new Promise((r) => setTimeout(r, 5000));
        try {
            await execFileAsync(process.execPath, [cliPath, 'sync', 'stop'], { env: cliEnv(home, dbFile, ingestEnv) });
        } catch {
            onlineChild2.kill('SIGTERM');
        }

        const contextsAfter = await apiJson('GET', '/contexts?limit=50', undefined, auth.accessA);
        const afterList = (contextsAfter.body.data as any[]) ?? [];
        assert.ok(afterList.length > beforeCount, 'expected new context from offline replay');
        const hit = afterList.find((c) => JSON.stringify(c.metadata ?? {}).includes('offline-e2e'));
        assert.ok(hit?.id, 'expected daemon-created context for offline session');
        const ctx = await apiJson('GET', `/contexts/${hit.id}`, undefined, auth.accessA);
        const msgs = (ctx.body.data as any[]) ?? [];
        assert.ok(msgs.length >= 1, `expected messages on daemon context, got ${msgs.length}`);
        const blob = JSON.stringify(msgs);
        assert.ok(blob.includes('xyzzy'), `offline line should reach server after reconnect: ${blob.slice(0, 400)}`);
    });
});
