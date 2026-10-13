import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { computeDekProof, createVaultCryptoMaterial, generateClientNodeId } from '@infinitecontext/crypto';

import { createLivePostgresApp } from './helpers/live-postgres-app';
import { verifyMigrationChainForDatabase } from './helpers/ensure-live-postgres';

const DB_URL = process.env.SYNC_E2E_DATABASE_URL ?? process.env.VAULT_E2E_DATABASE_URL;

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

async function registerUser(json: ReturnType<typeof createLivePostgresApp>['json']) {
    const email = `concurrent-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const register = await json('POST', '/auth/register', {
        email,
        password: 'password123456',
        device_id: 'device-stress',
    });
    assert.equal(register.res.status, 201);
    return String(register.body.access_token ?? '');
}

describe('concurrent-writer-postgres-live', () => {
    it('same-context plaintext PATCH stress — zero lost writes', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { json } = createLivePostgresApp();
        const token = await registerUser(json);
        const ctx = await json('POST', '/contexts', { metadata: { source: 'concurrent-plain' } }, token);
        assert.equal(ctx.res.status, 201);
        const contextId = String(ctx.body.id);

        const messageCount = 20;
        for (let i = 0; i < messageCount; i += 1) {
            const append = await json(
                'POST',
                `/contexts/${contextId}`,
                { role: 'user', text: `seed-${i}` },
                token,
            );
            assert.equal(append.res.status, 201);
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
                    { updates: [{ index: i, text: `final-${i}` }] },
                    token,
                ),
            ),
        );
        assert.ok(
            patchResults.every((r) => r.res.status === 200),
            patchResults.map((r) => r.res.status).join(','),
        );

        const finalGet = await json('GET', `/contexts/${contextId}`, undefined, token);
        assert.equal(finalGet.res.status, 200);
        const finalRows = (finalGet.body.data as Array<{ text?: string }>) ?? [];
        const finalTexts = new Set(finalRows.map((m) => String(m.text ?? '')));
        for (let i = 0; i < messageCount; i += 1) {
            assert.ok(finalTexts.has(`final-${i}`), `lost plaintext patch final-${i}`);
        }
    });

    it('cross-context plaintext PATCH stress — contexts stay isolated', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { json } = createLivePostgresApp();
        const token = await registerUser(json);
        const ctxA = await json('POST', '/contexts', { metadata: { source: 'cross-a' } }, token);
        const ctxB = await json('POST', '/contexts', { metadata: { source: 'cross-b' } }, token);
        const idA = String(ctxA.body.id);
        const idB = String(ctxB.body.id);
        await json('POST', `/contexts/${idA}`, { role: 'user', text: 'a-only' }, token);
        await json('POST', `/contexts/${idB}`, { role: 'user', text: 'b-only' }, token);

        const [patchA, patchB] = await Promise.all([
            json('PATCH', `/contexts/${idA}`, { updates: [{ index: 0, text: 'a-final' }] }, token),
            json('PATCH', `/contexts/${idB}`, { updates: [{ index: 0, text: 'b-final' }] }, token),
        ]);
        assert.equal(patchA.res.status, 200);
        assert.equal(patchB.res.status, 200);

        const readA = await json('GET', `/contexts/${idA}`, undefined, token);
        const readB = await json('GET', `/contexts/${idB}`, undefined, token);
        assert.equal((readA.body.data as Array<{ text?: string }>)[0]?.text, 'a-final');
        assert.equal((readB.body.data as Array<{ text?: string }>)[0]?.text, 'b-final');
    });

    it('vault encrypted PATCH stress — zero lost writes, ciphertext only on wire', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { json } = createLivePostgresApp();
        const token = await registerUser(json);
        const material = await createVaultCryptoMaterial('vault-concurrent-pass');
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
        const userPublicId = String(me.body.id);
        const crypto = await import('@infinitecontext/crypto');

        const ctx = await json('POST', '/contexts', { metadata: { source: 'vault-concurrent' } }, token);
        const contextId = String(ctx.body.id);
        const nodeIds: string[] = [];
        for (let i = 0; i < 8; i += 1) {
            const nodeId = generateClientNodeId();
            nodeIds.push(nodeId);
            const aad = { contextId, userPublicId, nodePublicId: nodeId };
            const enc = {
                id: nodeId,
                ...crypto.encryptNodeContent(material.dek, 1, { role: 'user', text: `enc-${i}` }, aad),
                metadata: crypto.encryptNodeMetadata(material.dek, 1, { ic_client_node_id: nodeId }, aad),
            };
            const append = await json('POST', `/contexts/${contextId}`, enc, token);
            assert.equal(append.res.status, 201);
        }

        const patchResults = await Promise.all(
            nodeIds.map((nodeId, i) => {
                const aad = { contextId, userPublicId, nodePublicId: nodeId };
                const envelope = crypto.encryptNodeContent(
                    material.dek,
                    1,
                    { role: 'user', text: `enc-final-${i}` },
                    aad,
                );
                return json(
                    'PATCH',
                    `/contexts/${contextId}`,
                    { updates: [{ id: nodeId, ...envelope }] },
                    token,
                );
            }),
        );
        assert.ok(patchResults.every((r) => r.res.status === 200));
        for (const r of patchResults) {
            const payload = JSON.stringify(r.body);
            assert.ok(!payload.includes('enc-final-'), 'vault PATCH response must not leak plaintext');
        }

        const read = await json('GET', `/contexts/${contextId}`, undefined, token);
        assert.equal(read.res.status, 200);
        const rows = (read.body.data as Array<Record<string, unknown>>) ?? [];
        assert.equal(rows.length, nodeIds.length);
        const decryptedTexts = new Set<string>();
        for (const row of rows) {
            assert.equal(row.__ic_enc, 1);
            const icn = String((row.metadata as { ic_client_node_id?: string } | undefined)?.ic_client_node_id ?? row.id);
            const aad = { contextId, userPublicId, nodePublicId: icn };
            const plain = crypto.decryptNodeContent(material.dek, row, aad) as { text?: string };
            decryptedTexts.add(String(plain.text ?? ''));
        }
        for (let i = 0; i < nodeIds.length; i += 1) {
            assert.ok(decryptedTexts.has(`enc-final-${i}`), `lost vault patch enc-final-${i}`);
        }
    });
});
