import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@infinitecontext/core';
import { MemoryStorage } from '@infinitecontext/core/testing';
import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    INFINITECONTEXT_ADMIN_KEY: 'test-admin-key',
};

async function setupApiKeyApp() {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage });
    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(apiKey);
    await storage.insertApiKey({ project_id: project!.id, key_prefix: prefix, key_hash: hash });
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    async function req(method: string, path: string, body?: unknown) {
        const init: RequestInit = { method, headers: { ...headers } };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await app.request(`http://127.0.0.1${path}`, init);
        const text = await res.text();
        return { res, body: text ? JSON.parse(text) : {} };
    }

    return { req };
}

describe('REST sync round 5 — API key plaintext icn', () => {
    it('PATCH and DELETE work without prior ic_client_node_id (server append stamp + fallback)', async () => {
        const { req } = await setupApiKeyApp();
        const created = await req('POST', '/contexts', {});
        assert.equal(created.res.status, 201);
        const contextId = String(created.body.id);

        const append = await req('POST', `/contexts/${contextId}`, { role: 'user', text: 'one' });
        assert.equal(append.res.status, 201);
        assert.match(String(append.body.data?.[0]?.metadata?.ic_client_node_id ?? ''), /^icn_/);

        const patch = await req('PATCH', `/contexts/${contextId}`, {
            updates: [{ index: 0, text: 'patched' }],
        });
        assert.equal(patch.res.status, 200);

        const del = await req('DELETE', `/contexts/${contextId}`, { ids: [0] });
        assert.equal(del.res.status, 200);
        assert.equal(del.body.data?.length, 0);
    });
});
