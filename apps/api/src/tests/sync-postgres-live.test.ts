import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { computeDekProof, createVaultCryptoMaterial, generateClientNodeId } from '@infinitecontext/crypto';

import { createLivePostgresApp } from './helpers/live-postgres-app';
import { verifyMigrationChainForDatabase } from './helpers/ensure-live-postgres';

const DB_URL = process.env.SYNC_E2E_DATABASE_URL ?? process.env.VAULT_E2E_DATABASE_URL;

let postgresReady = false;

before(async () => {
    if (!DB_URL || !process.env.POSTGRES_PASSWORD) {
        postgresReady = false;
        console.warn('sync-postgres-live skipped: set SYNC_E2E_DATABASE_URL and POSTGRES_PASSWORD.');
        return;
    }
    postgresReady = verifyMigrationChainForDatabase(DB_URL, process.env.POSTGRES_PASSWORD);
    if (!postgresReady) {
        console.warn('sync-postgres-live skipped: migration verify failed');
    }
});

async function setupApp() {
    const { json } = createLivePostgresApp();

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

    it('stores 10k appends from 8 parallel pushers (change log matches nodes)', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'parallel-append', session_id: 'pa1' } },
                    },
                ],
            },
            fx.accessA,
        );
        assert.equal(create.res.status, 200);
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');

        const total = 10_000;
        const workers = 8;
        const perWorker = total / workers;

        const worker = async (offset: number) => {
            const batchSize = 50;
            for (let i = 0; i < perWorker; i += batchSize) {
                const mutations = [];
                for (let j = 0; j < batchSize && i + j < perWorker; j += 1) {
                    const n = offset + i + j;
                    const mId = generateClientNodeId();
                    mutations.push({
                        client_id: generateClientNodeId(),
                        op: 'message_append',
                        context_id: contextId,
                        payload: {
                            messages: [{ id: mId, role: 'user', content: { message: `m-${n}` }, metadata: { ic_client_node_id: mId } }],
                        },
                    });
                }
                const push = await fx.json('POST', '/sync/push', { mutations }, fx.accessA);
                assert.equal(push.res.status, 200, JSON.stringify(push.body));
                const retryable = (push.body.failed as any[])?.filter((f) => f.retryable) ?? [];
                assert.equal(retryable.length, 0, `retryable failures: ${JSON.stringify(retryable.slice(0, 3))}`);
            }
        };

        await Promise.all(Array.from({ length: workers }, (_, w) => worker(w * perWorker)));

        const read = await fx.json('GET', `/contexts/${contextId}?limit=20000`, undefined, fx.accessA);
        assert.equal(read.res.status, 200);
        const stored = ((read.body.data as any[]) ?? []).length;
        assert.equal(stored, total, `expected ${total} stored messages, got ${stored}`);

        let since = 0;
        let appendOps = 0;
        while (appendOps < total + 50) {
            const pull = await fx.json('GET', `/sync/changes?since=${since}&limit=1000`, undefined, fx.accessA);
            const batch = (pull.body.changes as any[]) ?? [];
            if (batch.length === 0) break;
            appendOps += batch.filter((c) => c.op === 'message_append').length;
            since = Number(pull.body.next_since ?? since);
            if (!pull.body.has_more) break;
        }
        assert.equal(appendOps, total);
    });

    it('paginates 10k changes with no gaps/duplicates under concurrent push', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const batchSize = 100;
        const batches = 100;
        let head = 0;

        const pushWorker = async (start: number) => {
            for (let b = 0; b < batches / 2; b += 1) {
                const mutations = [];
                for (let i = 0; i < batchSize; i += 1) {
                    const n = start + b * batchSize + i;
                    mutations.push({
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'bulk10k', n } },
                    });
                }
                const push = await fx.json('POST', '/sync/push', { mutations }, fx.accessA);
                assert.equal(push.res.status, 200);
                head = Math.max(head, Number(push.body.head_sequence ?? 0));
            }
        };

        await Promise.all([pushWorker(0), pushWorker((batches / 2) * batchSize)]);

        const seen = new Set<number>();
        let since = 0;
        let pages = 0;
        while (pages < 200) {
            const pull = await fx.json('GET', `/sync/changes?since=${since}&limit=500`, undefined, fx.accessA);
            const batch = (pull.body.changes as any[]) ?? [];
            if (batch.length === 0) break;
            for (const row of batch) {
                const seq = Number(row.sequence);
                assert.ok(!seen.has(seq), `duplicate sequence ${seq}`);
                seen.add(seq);
                assert.ok(seq > since, 'sequences must increase');
            }
            since = Number(pull.body.next_since ?? since);
            pages += 1;
            if (!pull.body.has_more) break;
        }
        assert.equal(seen.size, batches * batchSize);
        assert.ok(head >= seen.size);
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

    it('REST PATCH by index logs affected_client_ids; REST DELETE by index rejects stale base', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'rest-index', session_id: 'ri1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const m1 = generateClientNodeId();
        await fx.json(
            'POST',
            `/contexts/${contextId}`,
            { id: m1, role: 'user', content: { message: 'hello' }, metadata: { ic_client_node_id: m1 } },
            fx.accessA,
        );

        const read0 = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessA);
        const baseSeq = Number(read0.body.sync_base_sequence ?? 0);
        assert.ok(baseSeq > 0);

        const patch = await fx.json(
            'PATCH',
            `/contexts/${contextId}`,
            { updates: [{ index: 0, role: 'user', content: { message: 'patched' } }] },
            fx.accessA,
        );
        assert.equal(patch.res.status, 200);

        const pullAfterPatch = await fx.json('GET', `/sync/changes?since=${baseSeq}&limit=20`, undefined, fx.accessA);
        const updateChange = (pullAfterPatch.body.changes as any[])?.find((c) => c.op === 'message_update');
        assert.ok(updateChange, 'expected message_update change');
        assert.deepEqual(updateChange.payload.affected_client_ids, [m1]);

        const read1 = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessA);
        const baseAfterPatch = Number(read1.body.sync_base_sequence ?? 0);

        await fx.json(
            'PATCH',
            `/contexts/${contextId}`,
            { updates: [{ index: 0, role: 'user', content: { message: 'patched again' } }] },
            fx.accessA,
        );

        const delStale = await fx.json(
            'DELETE',
            `/contexts/${contextId}`,
            { ids: [0], base_sequence: baseAfterPatch },
            fx.accessA,
        );
        assert.equal(delStale.res.status, 409);
        assert.equal((delStale.body as any).conflict, 'delete_stale_base');

        const conflicts = await fx.json('GET', '/sync/conflicts?since=0&limit=50', undefined, fx.accessA);
        const staleConflict = (conflicts.body.data as any[])?.find((c) => c.kind === 'delete_stale_base');
        assert.ok(staleConflict, 'expected sync_conflicts row for REST 409 stale delete');

        const badBase = await fx.json(
            'DELETE',
            `/contexts/${contextId}`,
            { ids: [0], base_sequence: 'abc' },
            fx.accessA,
        );
        assert.equal(badBase.res.status, 400);

        const aboveHead = await fx.json(
            'DELETE',
            `/contexts/${contextId}`,
            { ids: [0], base_sequence: 9_007_199_254_740_991 },
            fx.accessA,
        );
        assert.equal(aboveHead.res.status, 400);
    });

    it('device A: read C, B edits msg 1, A edits msg 0, delete msg 1 stale at original base', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'stale-ab', session_id: 'ab1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const m1 = generateClientNodeId();
        const m2 = generateClientNodeId();
        await fx.json(
            'POST',
            `/contexts/${contextId}`,
            [
                { id: m1, role: 'user', content: { message: 'one' }, metadata: { ic_client_node_id: m1 } },
                { id: m2, role: 'user', content: { message: 'two' }, metadata: { ic_client_node_id: m2 } },
            ],
            fx.accessA,
        );

        const readA = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessA);
        const baseInitial = Number(readA.body.sync_base_sequence ?? 0);
        assert.ok(baseInitial > 0);

        const patchB = await fx.json(
            'PATCH',
            `/contexts/${contextId}`,
            { updates: [{ index: 1, role: 'user', content: { message: 'b-edited' } }] },
            fx.accessB,
        );
        assert.equal(patchB.res.status, 200);

        const patchA = await fx.json(
            'PATCH',
            `/contexts/${contextId}`,
            { updates: [{ index: 0, role: 'user', content: { message: 'a-edited' } }] },
            fx.accessA,
            { 'X-IC-Base-Sequence': String(baseInitial) },
        );
        assert.equal(patchA.res.status, 200);

        const delStale = await fx.json(
            'DELETE',
            `/contexts/${contextId}`,
            { ids: [1] },
            fx.accessA,
            { 'X-IC-Base-Sequence': String(baseInitial) },
        );
        assert.equal(delStale.res.status, 409);
        assert.equal((delStale.body as any).conflict, 'delete_stale_base');

        const after = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessA);
        const rows = (after.body.data as any[]) ?? [];
        assert.equal(rows.length, 2);
        assert.equal(rows[1]?.content?.message ?? rows[1]?.message, 'b-edited');
    });

    it('message_delete with stale base_sequence records conflict instead of deleting', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'del-race', session_id: 'dr1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
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
                        payload: { messages: [{ id: m1, role: 'user', content: { message: 'one' }, metadata: { ic_client_node_id: m1 } }] },
                    },
                    {
                        client_id: m2,
                        op: 'message_append',
                        context_id: contextId,
                        payload: { messages: [{ id: m2, role: 'user', content: { message: 'two' }, metadata: { ic_client_node_id: m2 } }] },
                    },
                ],
            },
            fx.accessA,
        );
        const statusBefore = await fx.json('GET', '/sync/status', undefined, fx.accessA);
        const baseSeq = Number(statusBefore.body.head_sequence ?? 0);

        await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_update',
                        context_id: contextId,
                        payload: {
                            updates: [{ id: m1, role: 'user', content: { message: 'one edited' }, metadata: { ic_client_node_id: m1 } }],
                        },
                    },
                ],
            },
            fx.accessA,
        );

        const delAttempt = await fx.json(
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
            fx.accessB,
        );
        assert.equal(delAttempt.res.status, 200);
        const conflictKinds = (delAttempt.body.conflicts as any[])?.map((c) => c.kind) ?? [];
        assert.ok(conflictKinds.includes('delete_stale_base'), `expected delete_stale_base, got ${conflictKinds.join(',')}`);

        const read = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessA);
        assert.equal((read.body.data as any[])?.length, 2);
    });

    it('message_update on a different icn id succeeds after message_delete', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'del-then-upd', session_id: 'dtu1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
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
                        payload: { messages: [{ id: m1, role: 'user', content: { message: 'drop me' }, metadata: { ic_client_node_id: m1 } }] },
                    },
                    {
                        client_id: m2,
                        op: 'message_append',
                        context_id: contextId,
                        payload: { messages: [{ id: m2, role: 'user', content: { message: 'keep' }, metadata: { ic_client_node_id: m2 } }] },
                    },
                ],
            },
            fx.accessA,
        );
        const headBeforeDel = await fx.json('GET', '/sync/status', undefined, fx.accessA);
        const del = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_delete',
                        context_id: contextId,
                        base_sequence: Number(headBeforeDel.body.head_sequence ?? 0),
                        payload: { ids: [m1] },
                    },
                ],
            },
            fx.accessB,
        );
        assert.equal(del.res.status, 200);
        const upd = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_update',
                        context_id: contextId,
                        payload: {
                            updates: [{ id: m2, role: 'user', content: { message: 'keep edited' }, metadata: { ic_client_node_id: m2 } }],
                        },
                    },
                ],
            },
            fx.accessA,
        );
        assert.equal(upd.res.status, 200);
        const failedCodes = (upd.body.failed as any[])?.map((f) => f.code) ?? [];
        assert.ok(!failedCodes.includes('context_deleted'), `unexpected context_deleted: ${failedCodes.join(',')}`);

        const read = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessA);
        const messages = (read.body.data as any[]) ?? [];
        assert.equal(messages.length, 1);
        assert.match(String(messages[0]?.content?.message ?? ''), /keep edited/);
    });

    it('delete stale check is scoped to the deleted icn id (edit on another message does not block)', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'del-scope', session_id: 'ds1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
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
                        payload: { messages: [{ id: m1, role: 'user', content: { message: 'one' }, metadata: { ic_client_node_id: m1 } }] },
                    },
                    {
                        client_id: m2,
                        op: 'message_append',
                        context_id: contextId,
                        payload: { messages: [{ id: m2, role: 'user', content: { message: 'two' }, metadata: { ic_client_node_id: m2 } }] },
                    },
                ],
            },
            fx.accessA,
        );
        const statusBefore = await fx.json('GET', '/sync/status', undefined, fx.accessA);
        const baseSeq = Number(statusBefore.body.head_sequence ?? 0);
        await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_update',
                        context_id: contextId,
                        payload: {
                            updates: [{ id: m1, role: 'user', content: { message: 'one edited' }, metadata: { ic_client_node_id: m1 } }],
                        },
                    },
                ],
            },
            fx.accessA,
        );
        const delOther = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_delete',
                        context_id: contextId,
                        base_sequence: baseSeq,
                        payload: { ids: [m2] },
                    },
                ],
            },
            fx.accessB,
        );
        assert.equal(delOther.res.status, 200);
        const conflictKinds = (delOther.body.conflicts as any[])?.map((c) => c.kind) ?? [];
        assert.ok(!conflictKinds.includes('delete_stale_base'), conflictKinds.join(','));
        const read = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessA);
        assert.equal((read.body.data as any[])?.length, 1);
    });

    it('message_delete change log omits full context snapshot', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'del-slim', session_id: 'sl1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
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
                    {
                        client_id: m2,
                        op: 'message_append',
                        context_id: contextId,
                        payload: { messages: [{ id: m2, role: 'user', content: { message: 'b' }, metadata: { ic_client_node_id: m2 } }] },
                    },
                ],
            },
            fx.accessA,
        );
        const head = await fx.json('GET', '/sync/status', undefined, fx.accessA);
        await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_delete',
                        context_id: contextId,
                        base_sequence: Number(head.body.head_sequence ?? 0),
                        payload: { ids: [m1] },
                    },
                ],
            },
            fx.accessA,
        );
        const pull = await fx.json('GET', '/sync/changes?since=0&limit=200', undefined, fx.accessA);
        const delChange = (pull.body.changes as any[])?.find((c) => c.op === 'message_delete');
        assert.ok(delChange?.payload?.deleted_client_ids?.includes(m1));
        assert.equal(delChange?.payload?.data, undefined);
    });

    it('invalid_input on one mutation does not fail the whole push batch', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'batch-fail', session_id: 'bf1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const bad = generateClientNodeId();
        const good = generateClientNodeId();
        const push = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: bad,
                        op: 'message_update',
                        context_id: contextId,
                        payload: {
                            data: [{ id: generateClientNodeId(), role: 'user', content: { message: 'nope' } }],
                        },
                    },
                    {
                        client_id: good,
                        op: 'message_append',
                        context_id: contextId,
                        payload: {
                            messages: [{ id: good, role: 'user', content: { message: 'ok' }, metadata: { ic_client_node_id: good } }],
                        },
                    },
                ],
            },
            fx.accessA,
        );
        assert.equal(push.res.status, 200);
        assert.ok((push.body.failed as any[])?.some((f) => f.code === 'invalid_input'));
        assert.ok((push.body.applied as string[])?.includes(good));
    });

    it('contexts_delete_many records only successfully deleted ids in results', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const c1 = generateClientNodeId();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [{ client_id: c1, op: 'context_create', payload: { metadata: { source: 'dm-partial', n: 1 } } }],
            },
            fx.accessA,
        );
        const ctx1 = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const delMany = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'contexts_delete_many',
                        payload: { ids: [ctx1, 'ctx_does_not_exist_000000000000000000000000'] },
                    },
                ],
            },
            fx.accessA,
        );
        assert.equal(delMany.res.status, 200);
        const pull = await fx.json('GET', '/sync/changes?since=0&limit=200', undefined, fx.accessA);
        const row = (pull.body.changes as any[])?.find((c) => c.op === 'contexts_delete_many');
        const results = (row?.payload?.results as any[]) ?? [];
        assert.ok(results.some((r) => r.id === ctx1 && r.deleted === true));
        assert.ok(results.some((r) => r.id === 'ctx_does_not_exist_000000000000000000000000' && r.deleted === false));
    });

    it('REST DELETE logs deleted_client_ids for replica consumers', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'rest-del', session_id: 'rd1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const m1 = generateClientNodeId();
        await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: m1,
                        op: 'message_append',
                        context_id: contextId,
                        payload: { messages: [{ id: m1, role: 'user', content: { message: 'x' }, metadata: { ic_client_node_id: m1 } }] },
                    },
                ],
            },
            fx.accessA,
        );
        const readBeforeDel = await fx.json('GET', `/contexts/${contextId}`, undefined, fx.accessA);
        const delBase = Number(readBeforeDel.body.sync_base_sequence ?? 0);
        const del = await fx.json(
            'DELETE',
            `/contexts/${contextId}`,
            { ids: [m1], base_sequence: delBase },
            fx.accessA,
        );
        assert.equal(del.res.status, 200);
        const pull = await fx.json('GET', '/sync/changes?since=0&limit=200', undefined, fx.accessA);
        const delChange = (pull.body.changes as any[])?.find((c) => c.op === 'message_delete' && c.context_id === contextId);
        assert.ok(Array.isArray(delChange?.payload?.deleted_client_ids));
        assert.ok(delChange?.payload?.deleted_client_ids?.includes(m1));
        assert.equal(delChange?.payload?.data, undefined);
    });

    it('EXPLAIN stale EXISTS references GIN indexes on affected/deleted ids', async () => {
        if (!postgresReady || !DB_URL) return;
        await setupApp();
        const icn = generateClientNodeId();
        const psqlEnv = { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD };
        const userIdRaw = spawnSync('psql', [DB_URL, '-t', '-A', '-c', 'SELECT id FROM users ORDER BY id DESC LIMIT 1'], {
            encoding: 'utf8',
            env: psqlEnv,
        });
        assert.equal(userIdRaw.status, 0, userIdRaw.stderr || userIdRaw.stdout);
        const userId = Number(String(userIdRaw.stdout ?? '').trim());
        assert.ok(Number.isFinite(userId) && userId > 0);

        const contextId = `ctx_gin_explain_${Date.now()}`;
        const seqBaseRaw = spawnSync(
            'psql',
            [DB_URL, '-t', '-A', '-c', `SELECT COALESCE(MAX(sequence), 0) + 1 FROM sync_change_log WHERE user_id = ${userId}`],
            { encoding: 'utf8', env: psqlEnv },
        );
        assert.equal(seqBaseRaw.status, 0, seqBaseRaw.stderr || seqBaseRaw.stdout);
        const seqBase = Number(String(seqBaseRaw.stdout ?? '').trim());
        const icnJson = JSON.stringify([icn]);
        const seedSql = `
INSERT INTO sync_change_log (user_id, sequence, op, context_id, client_id, payload)
SELECT ${userId}, ${seqBase} + s, 'message_update', '${contextId}', 'gin_seed_${Date.now()}_' || s,
  jsonb_build_object('affected_client_ids', jsonb_build_array('icn_seed_' || s::text))
FROM generate_series(1, 400) s;
INSERT INTO sync_change_log (user_id, sequence, op, context_id, client_id, payload)
VALUES (${userId}, ${seqBase + 401}, 'message_update', '${contextId}', 'gin_target_${Date.now()}',
  jsonb_build_object('affected_client_ids', jsonb_build_array('${icn}')));
ANALYZE sync_change_log;`;
        const seed = spawnSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', seedSql], { encoding: 'utf8', env: psqlEnv });
        assert.equal(seed.status, 0, seed.stderr || seed.stdout);

        const explainSql = `
BEGIN;
SET LOCAL enable_seqscan = off;
EXPLAIN (FORMAT TEXT)
SELECT EXISTS (
  SELECT 1 FROM sync_change_log
  WHERE user_id = ${userId} AND context_id = '${contextId}' AND sequence > ${seqBase - 1}
    AND op IN ('message_update', 'message_delete')
    AND (
      COALESCE(payload->'affected_client_ids', '[]'::jsonb) @> '${icnJson}'::jsonb
      OR COALESCE(payload->'deleted_client_ids', '[]'::jsonb) @> '${icnJson}'::jsonb
    )
);
ROLLBACK;`;
        const out = spawnSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', explainSql], {
            encoding: 'utf8',
            env: psqlEnv,
        });
        assert.equal(out.status, 0, out.stderr || out.stdout);
        assert.match(out.stdout ?? '', /@>/);
        assert.match(out.stdout ?? '', /idx_sync_change_log_(affected|deleted)_client_ids|Bitmap Index Scan/i);
    });
});

describe('sync-postgres-live vault', () => {
    it('round-trips encrypted append via sync push', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const material = await createVaultCryptoMaterial('vault-sync-pass1');
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
        const appendChange = (pull.body.changes as any[]).find((c) => c.op === 'message_append');
        const payload = JSON.stringify(appendChange?.payload ?? {});
        assert.ok(payload.includes('__ic_enc') || payload.includes('ciphertext'), 'vault change log must not store plaintext bodies');
    });

    it('contexts_delete_many works via sync push under vault', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const c1 = generateClientNodeId();
        const c2 = generateClientNodeId();
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    { client_id: c1, op: 'context_create', payload: { metadata: { source: 'bulk-del', n: 1 } } },
                    { client_id: c2, op: 'context_create', payload: { metadata: { source: 'bulk-del', n: 2 } } },
                ],
            },
            fx.accessA,
        );
        assert.equal(create.res.status, 200);
        const ctx1 = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const ctx2 = String((create.body.effects as any[])?.[1]?.context_id ?? '');
        const material = await createVaultCryptoMaterial('vaultDelMany1Pass');
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
        const delMany = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'contexts_delete_many',
                        payload: { ids: [ctx1, ctx2] },
                    },
                ],
            },
            fx.accessA,
        );
        assert.equal(delMany.res.status, 200, JSON.stringify(delMany.body));
        const pull = await fx.json('GET', '/sync/changes?since=0&limit=200', undefined, fx.accessA);
        const delChange = (pull.body.changes as any[])?.find((c) => c.op === 'contexts_delete_many');
        assert.ok(Number(delChange?.payload?.deleted_count ?? 0) >= 2, JSON.stringify(delChange?.payload));
    });

    it('rejects plaintext message_update via sync push', async () => {
        if (!postgresReady) return;
        const fx = await setupApp();
        const material = await createVaultCryptoMaterial('vault-sync-pass1');
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
        const create = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'context_create',
                        payload: { metadata: { source: 'vault-upd', session_id: 'vu1' } },
                    },
                ],
            },
            fx.accessA,
        );
        const contextId = String((create.body.effects as any[])?.[0]?.context_id ?? '');
        const nodeId = generateClientNodeId();
        const upd = await fx.json(
            'POST',
            '/sync/push',
            {
                mutations: [
                    {
                        client_id: generateClientNodeId(),
                        op: 'message_update',
                        context_id: contextId,
                        payload: {
                            updates: [{ id: nodeId, role: 'user', content: { message: 'plain' }, metadata: { ic_client_node_id: nodeId } }],
                        },
                    },
                ],
            },
            fx.accessA,
        );
        assert.equal(upd.res.status, 422);
    });
});
