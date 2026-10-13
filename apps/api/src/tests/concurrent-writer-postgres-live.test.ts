import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { computeDekProof, createVaultCryptoMaterial, generateClientNodeId } from '@infinitecontext/crypto';

import { createLivePostgresApp } from './helpers/live-postgres-app';
import { verifyMigrationChainForDatabase } from './helpers/ensure-live-postgres';

const DB_URL = process.env.SYNC_E2E_DATABASE_URL ?? process.env.VAULT_E2E_DATABASE_URL;
const TRIALS = 30;

let postgresReady = false;

before(async () => {
    if (!DB_URL || !process.env.POSTGRES_PASSWORD) {
        postgresReady = false;
        console.warn(
            'concurrent-writer-postgres-live skipped: set SYNC_E2E_DATABASE_URL (or VAULT_E2E_DATABASE_URL) and POSTGRES_PASSWORD.',
        );
        return;
    }
    postgresReady = verifyMigrationChainForDatabase(DB_URL, process.env.POSTGRES_PASSWORD);
});

async function setupVaultClient() {
    const live = createLivePostgresApp();
    const email = `vault-stress-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const register = await live.json('POST', '/auth/register', {
        email,
        password: 'password123456',
        device_id: 'device-vault-stress',
    });
    assert.ok(register.res.status === 200 || register.res.status === 201);
    const accessToken = String(register.body.access_token ?? '');
    const me = await live.json('GET', '/auth/me', undefined, accessToken);
    const material = await createVaultCryptoMaterial('vault-concurrent-stress-pass1');
    await live.json(
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
            fetch: (input: RequestInfo | URL, init?: RequestInit) => live.app.request(String(input), init),
        }),
        {
            dek: material.dek,
            dekVersion: 1,
            userPublicId: String(me.body.id),
        },
    );
    return { vaultClient, json: live.json, accessToken };
}

async function registerUser(json: ReturnType<typeof createLivePostgresApp>['json']) {
    const email = `concurrent-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const register = await json('POST', '/auth/register', {
        email,
        password: 'password123456',
        device_id: 'device-stress',
    });
    assert.ok(register.res.status === 200 || register.res.status === 201, `register status ${register.res.status}`);
    return String(register.body.access_token ?? '');
}

describe('concurrent-writer-postgres-live', () => {
    it(`same-context plaintext PATCH stress — ${TRIALS} trials, zero lost writes`, async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        for (let trial = 0; trial < TRIALS; trial += 1) {
            const { json } = createLivePostgresApp();
            const token = await registerUser(json);
            const ctx = await json('POST', '/contexts', { metadata: { source: 'concurrent-plain', trial } }, token);
            assert.equal(ctx.res.status, 201, `trial ${trial} create`);
            const contextId = String(ctx.body.id);

            const messageCount = 20;
            for (let i = 0; i < messageCount; i += 1) {
                const append = await json(
                    'POST',
                    `/contexts/${contextId}`,
                    { role: 'user', text: `seed-${i}` },
                    token,
                );
                assert.equal(append.res.status, 201, `trial ${trial} append ${i}`);
            }

            const get0 = await json('GET', `/contexts/${contextId}`, undefined, token);
            assert.equal(get0.res.status, 200);
            const rows = (get0.body.data as Array<{ id: string; text?: string }>) ?? [];
            assert.equal(rows.length, messageCount);

            const patchResults = await Promise.all(
                rows.map((_, i) =>
                    json(
                        'PATCH',
                        `/contexts/${contextId}`,
                        { updates: [{ index: i, text: `final-${trial}-${i}` }] },
                        token,
                    ),
                ),
            );
            assert.ok(
                patchResults.every((r) => r.res.status === 200),
                `trial ${trial} statuses: ${patchResults.map((r) => r.res.status).join(',')}`,
            );

            const finalGet = await json('GET', `/contexts/${contextId}`, undefined, token);
            assert.equal(finalGet.res.status, 200);
            const finalRows = (finalGet.body.data as Array<{ text?: string }>) ?? [];
            const finalTexts = new Set(finalRows.map((m) => String(m.text ?? '')));
            for (let i = 0; i < messageCount; i += 1) {
                assert.ok(finalTexts.has(`final-${trial}-${i}`), `trial ${trial} lost plaintext patch final-${trial}-${i}`);
            }
        }
    });

    it(`cross-context plaintext PATCH stress — ${TRIALS} trials, contexts stay isolated`, async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        for (let trial = 0; trial < TRIALS; trial += 1) {
            const { json } = createLivePostgresApp();
            const token = await registerUser(json);
            const ctxA = await json('POST', '/contexts', { metadata: { source: 'cross-a', trial } }, token);
            const ctxB = await json('POST', '/contexts', { metadata: { source: 'cross-b', trial } }, token);
            const idA = String(ctxA.body.id);
            const idB = String(ctxB.body.id);
            await json('POST', `/contexts/${idA}`, { role: 'user', text: 'a-only' }, token);
            await json('POST', `/contexts/${idB}`, { role: 'user', text: 'b-only' }, token);

            const [patchA, patchB] = await Promise.all([
                json('PATCH', `/contexts/${idA}`, { updates: [{ index: 0, text: `a-final-${trial}` }] }, token),
                json('PATCH', `/contexts/${idB}`, { updates: [{ index: 0, text: `b-final-${trial}` }] }, token),
            ]);
            assert.equal(patchA.res.status, 200, `trial ${trial} patchA`);
            assert.equal(patchB.res.status, 200, `trial ${trial} patchB`);

            const readA = await json('GET', `/contexts/${idA}`, undefined, token);
            const readB = await json('GET', `/contexts/${idB}`, undefined, token);
            assert.equal((readA.body.data as Array<{ text?: string }>)[0]?.text, `a-final-${trial}`);
            assert.equal((readB.body.data as Array<{ text?: string }>)[0]?.text, `b-final-${trial}`);
        }
    });

    it(`vault encrypted PATCH stress — ${TRIALS} trials, zero lost writes`, async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        for (let trial = 0; trial < TRIALS; trial += 1) {
            const { vaultClient } = await setupVaultClient();
            const created = await vaultClient.create({ metadata: { source: 'vault-concurrent', trial } });
            const contextId = created.id;
            const nodeIds: string[] = [];
            for (let i = 0; i < 8; i += 1) {
                const nodeId = generateClientNodeId();
                nodeIds.push(nodeId);
                await vaultClient.append(contextId, {
                    id: nodeId,
                    role: 'user',
                    text: `enc-${trial}-${i}`,
                    metadata: { ic_client_node_id: nodeId },
                });
            }

            await Promise.all(
                nodeIds.map((nodeId, i) =>
                    vaultClient.update(contextId, {
                        id: nodeId,
                        role: 'user',
                        text: `enc-final-${trial}-${i}`,
                    }),
                ),
            );

            const read = await vaultClient.get(contextId);
            assert.equal(read.data.length, nodeIds.length);
            const decryptedTexts = new Set(
                read.data.map((row: { text?: string }) => String(row.text ?? '')),
            );
            for (let i = 0; i < nodeIds.length; i += 1) {
                assert.ok(
                    decryptedTexts.has(`enc-final-${trial}-${i}`),
                    `trial ${trial} lost vault patch enc-final-${trial}-${i}`,
                );
            }
        }
    });
});
