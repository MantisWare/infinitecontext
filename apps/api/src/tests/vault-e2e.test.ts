import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMockGoogleOAuthClient } from '@infinitecontext/auth';
import { MemoryAuthRepository } from '@infinitecontext/auth/testing';
import {
    computeDekProof,
    createVaultCryptoMaterial,
    decodeRecoveryKey,
    deriveVaultKek,
    encryptNodeContent,
    encryptNodeMetadata,
    generateClientNodeId,
    recoveryKeyToKek,
    rewrapDekWithNewPassphrase,
    unwrapDek,
} from '@infinitecontext/crypto';
import { MemoryStorage } from '@infinitecontext/core/testing';

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

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
};

async function setupVaultE2E() {
    const storage = new MemoryStorage();
    const authRepo = new MemoryAuthRepository();
    const app = createApp({
        config: TEST_CONFIG,
        storage,
        authConfig: TEST_AUTH_CONFIG,
        authRepo,
        googleOAuth: createMockGoogleOAuthClient(),
        mailer: {
            async sendVerificationEmail() {},
            async sendPasswordResetEmail() {},
        },
    });

    async function json(method: string, path: string, body?: unknown, token?: string) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const init: RequestInit = { method, headers };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await app.request(`http://localhost${path}`, init);
        const text = await res.text();
        return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    }

    const register = await json('POST', '/auth/register', {
        email: 'vault-e2e@example.com',
        password: 'password123456',
    });
    const accessToken = String(register.body.access_token ?? '');

    const googleUser = await authRepo.createUser({
        publicId: 'usr_google_e2e',
        email: 'google-e2e@example.com',
        passwordHash: null,
        emailVerifiedAt: new Date().toISOString(),
    });
    await authRepo.ensureVaultPassphraseRequired(googleUser.id);
    const googleProject = await storage.insertProject('google-p');
    assert.ok(googleProject);
    await authRepo.linkUserProject(googleUser.id, googleProject.id);

    return { json, storage, authRepo, accessToken, googleUser, googleProjectId: googleProject.id, app };
}

function encryptedMessage(dek: Uint8Array, userPublicId: string, contextId: string) {
    const nodeId = generateClientNodeId();
    const aad = { contextId, userPublicId, nodePublicId: nodeId };
    const content = encryptNodeContent(dek, 1, { role: 'user', text: 'secret payload' }, aad);
    const metadata = encryptNodeMetadata(
        dek,
        1,
        { source: 'cli-test', note: 'hidden', ic_client_node_id: nodeId },
        aad,
    );
    return {
        id: nodeId,
        ...content,
        metadata,
    };
}

describe('vault CLI-equivalent e2e', () => {
    it('init, encrypted write/read, lock/unlock, passphrase change, recovery device', async () => {
        const { json, storage, accessToken, app } = await setupVaultE2E();

        const material = await createVaultCryptoMaterial('vault-pass-e2e1');
        const init = await json(
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
        assert.equal(init.res.status, 200);

        const create = await json('POST', '/contexts', { metadata: { source: 'cli-test' } }, accessToken);
        assert.equal(create.res.status, 201);
        const contextId = String(create.body.id);

        const plaintextAppend = await json(
            'POST',
            `/contexts/${contextId}`,
            { role: 'user', text: 'plaintext' },
            accessToken,
        );
        assert.equal(plaintextAppend.res.status, 422);

        const me = await json('GET', '/auth/me', undefined, accessToken);
        const userPublicId = String(me.body.id);

        const enc = encryptedMessage(material.dek, userPublicId, contextId);
        const append = await json('POST', `/contexts/${contextId}`, enc, accessToken);
        assert.equal(append.res.status, 201);

        const badMeta = {
            ...encryptedMessage(material.dek, userPublicId, contextId),
            metadata: {
                ...(enc.metadata as Record<string, unknown>),
                note: 'plaintext-in-metadata',
            },
        };
        const metaReject = await json('POST', `/contexts/${contextId}`, badMeta, accessToken);
        assert.equal(metaReject.res.status, 422);

        const dup = await json('POST', `/contexts/${contextId}`, enc, accessToken);
        assert.equal(dup.res.status, 409);

        const stableClientId = String((enc.metadata as Record<string, unknown>).ic_client_node_id ?? enc.id);
        const enc2 = encryptedMessage(material.dek, userPublicId, contextId);
        const patchPayload = {
            ...pickEnc(enc2),
            metadata: { ...enc2.metadata, ic_client_node_id: stableClientId },
        };
        const patchMsg = await json(
            'PATCH',
            `/contexts/${contextId}`,
            { updates: [{ index: 0, ...patchPayload }] },
            accessToken,
        );
        assert.equal(patchMsg.res.status, 200);
        const patchAgain = await json(
            'PATCH',
            `/contexts/${contextId}`,
            { updates: [{ index: 0, ...patchPayload }] },
            accessToken,
        );
        assert.equal(patchAgain.res.status, 200);

        const sdkRoot = path.resolve(process.cwd(), '../js-sdk');
        const { wrapInfiniteContextWithVault } = await import(path.join(sdkRoot, 'lib/encrypted-client.mjs') as string);
        const { InfiniteContext } = await import(path.join(sdkRoot, 'dist/index.mjs') as string);
        const vaultClient = wrapInfiniteContextWithVault(
            new InfiniteContext({
                baseUrl: 'http://localhost',
                accessToken,
                fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init),
            }),
            { dek: material.dek, dekVersion: 1, userPublicId },
        );
        const fork = await vaultClient.create({ from: contextId, metadata: { source: 'cow-fork' } });
        const withMeta = await vaultClient.append(fork.id, {
            role: 'user',
            text: 'meta-body',
            metadata: { event_id: 'ev_keep', note: 'keep-me' },
        });
        assert.equal(withMeta.data[0]?.metadata?.event_id, 'ev_keep');
        await vaultClient.update(fork.id, {
            updates: [{ id: withMeta.data[0]!.id, role: 'user', content: { message: 'updated-only' } }],
        });
        const afterMeta = await vaultClient.get(fork.id);
        const kept = afterMeta.data.find(
            (row: { metadata?: Record<string, unknown> }) => row.metadata?.event_id === 'ev_keep',
        );
        assert.ok(kept, 'expected prior metadata fields to survive content-only update');
        assert.equal(kept?.metadata?.note, 'keep-me');

        const storedNodes = (storage as unknown as { nodes: Array<{ content: Record<string, unknown> }> }).nodes;
        const hasCipher = storedNodes.some((n) => n.content.__ic_enc === 1);
        assert.equal(hasCipher, true);
        assert.equal(JSON.stringify(storedNodes).includes('secret payload'), false);

        const get = await json('GET', `/contexts/${contextId}`, undefined, accessToken);
        assert.equal(get.res.status, 200);

        let dek = material.dek;
        dek = unwrapDek(
            material.wrappedDekPassphrase,
            await deriveVaultKek('vault-pass-e2e1', material.kdfSalt),
        );
        assert.deepEqual(dek, material.dek);

        const rewrapped = await rewrapDekWithNewPassphrase({
            dek,
            newPassphrase: 'vault-pass-rotated1',
        });
        const patch = await json(
            'PATCH',
            '/auth/crypto',
            {
                wrapped_dek: Buffer.from(rewrapped.wrappedDek).toString('base64'),
                kdf_salt: Buffer.from(rewrapped.kdfSalt).toString('base64'),
                dek_proof: Buffer.from(computeDekProof(material.dek)).toString('base64'),
                expected_wrapped_dek: init.body.wrapped_dek,
                expected_wrapped_dek_recovery: init.body.wrapped_dek_recovery,
            },
            accessToken,
        );
        assert.equal(patch.res.status, 200);

        dek = unwrapDek(rewrapped.wrappedDek, await deriveVaultKek('vault-pass-rotated1', rewrapped.kdfSalt));
        assert.deepEqual(dek, material.dek);

        const recoveryKek = recoveryKeyToKek(decodeRecoveryKey(material.recoveryKeyDisplay));
        const dekFromRecovery = unwrapDek(material.wrappedDekRecovery, recoveryKek);
        assert.deepEqual(dekFromRecovery, material.dek);
    });
});

describe('vault append and prune guards', () => {
    it('rejects encrypted append to plaintext context and blocks prune for non-vault users', async () => {
        const { json } = await setupVaultE2E();
        const material = await createVaultCryptoMaterial('vault-guard-pass1');
        const plainUser = await json('POST', '/auth/register', {
            email: 'no-vault-prune@example.com',
            password: 'password123456',
        });
        const plainToken = String(plainUser.body.access_token ?? '');
        const ctx = await json('POST', '/contexts', { metadata: { source: 'prune-guard' } }, plainToken);
        const contextId = String(ctx.body.id);
        await json('POST', `/contexts/${contextId}`, { role: 'user', text: 'plain' }, plainToken);

        const prunePlain = await json('POST', `/contexts/${contextId}/prune-plaintext-versions`, {}, plainToken);
        assert.equal(prunePlain.res.status, 403);

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
        const enc = encryptedMessage(material.dek, String(me.body.id), contextId);
        const blocked = await json('POST', `/contexts/${contextId}`, enc, plainToken);
        assert.equal(blocked.res.status, 409);
    });
});

function pickEnc(msg: Record<string, unknown>) {
    return {
        __ic_enc: msg.__ic_enc,
        kid: msg.kid,
        v: msg.v,
        alg: msg.alg,
        nonce: msg.nonce,
        ct: msg.ct,
    };
}

describe('google vault gate', () => {
    it('blocks writes until vault init for google-only accounts', async () => {
        const { json, authRepo, googleUser, googleProjectId } = await setupVaultE2E();

        const session = await authRepo.createSession({
            publicId: 'sess_google_gate',
            userId: googleUser.id,
            refreshTokenHash: 'hash-google-gate',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        const { signAccessToken } = await import('@infinitecontext/auth');
        const signed = await signAccessToken(TEST_AUTH_CONFIG, {
            sub: googleUser.public_id,
            uid: googleUser.id,
            pid: googleProjectId,
            sid: session.id,
        });
        const accessToken = signed.token;

        const blocked = await json('POST', '/contexts', { metadata: { source: 'x' } }, accessToken);
        assert.equal(blocked.res.status, 403);
    });
});
