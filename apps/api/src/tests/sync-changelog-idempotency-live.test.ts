import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateClientNodeId } from '@infinitecontext/crypto';

import { createLivePostgresApp } from './helpers/live-postgres-app';
import { verifyMigrationChainForDatabase } from './helpers/ensure-live-postgres';

const DB_URL = process.env.SYNC_E2E_DATABASE_URL ?? process.env.VAULT_E2E_DATABASE_URL;

let postgresReady = false;

before(async () => {
    if (!DB_URL || !process.env.POSTGRES_PASSWORD) {
        postgresReady = false;
        return;
    }
    postgresReady = verifyMigrationChainForDatabase(DB_URL, process.env.POSTGRES_PASSWORD);
});

async function setupUser() {
    const { json } = createLivePostgresApp();
    const email = `sync-idem-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const register = await json('POST', '/auth/register', {
        email,
        password: 'password123456',
        device_id: 'sync-idem',
    });
    assert.ok(register.res.status === 200 || register.res.status === 201);
    return { json, token: String(register.body.access_token ?? '') };
}

async function countChangeLogRowsForClient(clientId: string): Promise<number> {
    const url = DB_URL!.replace(/^postgres:/, 'postgresql:');
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(
        'psql',
        [
            url,
            '-t',
            '-A',
            '-c',
            `SELECT COUNT(*) FROM sync_change_log WHERE client_id = '${clientId}';`,
        ],
        { encoding: 'utf8', env: { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD } },
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return Number(String(res.stdout ?? '').trim());
}

describe('sync-changelog-idempotency-live', () => {
    it('concurrent duplicate message_append — 0 duplicate messages in 10 contexts', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        const { json, token } = await setupUser();
        for (let ctxIndex = 0; ctxIndex < 10; ctxIndex += 1) {
            const ctxRes = await json(
                'POST',
                '/sync/push',
                {
                    mutations: [
                        {
                            client_id: generateClientNodeId(),
                            op: 'context_create',
                            payload: { metadata: { source: 'idem-append', ctxIndex } },
                        },
                    ],
                },
                token,
            );
            assert.equal(ctxRes.res.status, 200);
            const contextId = String((ctxRes.body.effects as { context_id?: string }[])?.[0]?.context_id ?? '');
            assert.ok(contextId.startsWith('ctx_'));

            const clientId = generateClientNodeId();
            const mutation = {
                client_id: clientId,
                op: 'message_append' as const,
                context_id: contextId,
                payload: {
                    messages: [{ id: clientId, role: 'user', text: `dup-${ctxIndex}`, metadata: { ic_client_node_id: clientId } }],
                },
            };

            const [a, b] = await Promise.all([
                json('POST', '/sync/push', { mutations: [mutation] }, token),
                json('POST', '/sync/push', { mutations: [mutation] }, token),
            ]);
            assert.equal(a.res.status, 200, `ctx ${ctxIndex} push A`);
            assert.equal(b.res.status, 200, `ctx ${ctxIndex} push B`);

            const read = await json('GET', `/contexts/${contextId}`, undefined, token);
            assert.equal(read.res.status, 200);
            const rows = (read.body.data as unknown[]) ?? [];
            assert.equal(rows.length, 1, `ctx ${ctxIndex} must have exactly one message`);

            const logRows = await countChangeLogRowsForClient(clientId);
            assert.equal(logRows, 1, `ctx ${ctxIndex} must have one changelog row for client_id`);
        }
    });

    it('concurrent same client_id different payload — 0 unlogged in 15 trials', async (t) => {
        if (!postgresReady) {
            t.skip();
            return;
        }
        for (let trial = 0; trial < 15; trial += 1) {
            const { json, token } = await setupUser();
            const ctxRes = await json(
                'POST',
                '/sync/push',
                {
                    mutations: [
                        {
                            client_id: generateClientNodeId(),
                            op: 'context_create',
                            payload: { metadata: { source: 'idem-diff', trial } },
                        },
                    ],
                },
                token,
            );
            const contextId = String((ctxRes.body.effects as { context_id?: string }[])?.[0]?.context_id ?? '');

            const clientId = generateClientNodeId();
            const base = {
                client_id: clientId,
                op: 'message_append' as const,
                context_id: contextId,
            };
            const [a, b] = await Promise.all([
                json(
                    'POST',
                    '/sync/push',
                    {
                        mutations: [
                            {
                                ...base,
                                payload: {
                                    messages: [
                                        {
                                            id: clientId,
                                            role: 'user',
                                            text: `payload-a-${trial}`,
                                            metadata: { ic_client_node_id: clientId },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                    token,
                ),
                json(
                    'POST',
                    '/sync/push',
                    {
                        mutations: [
                            {
                                ...base,
                                payload: {
                                    messages: [
                                        {
                                            id: clientId,
                                            role: 'user',
                                            text: `payload-b-${trial}`,
                                            metadata: { ic_client_node_id: clientId },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                    token,
                ),
            ]);
            assert.equal(a.res.status, 200);
            assert.equal(b.res.status, 200);

            const read = await json('GET', `/contexts/${contextId}`, undefined, token);
            const rows = (read.body.data as Array<{ text?: string }>) ?? [];
            assert.equal(rows.length, 1, `trial ${trial} duplicate messages`);
            const text = String(rows[0]?.text ?? '');
            assert.ok(
                text === `payload-a-${trial}` || text === `payload-b-${trial}`,
                `trial ${trial} unexpected content: ${text}`,
            );

            const logRows = await countChangeLogRowsForClient(clientId);
            assert.equal(logRows, 1, `trial ${trial} must have exactly one changelog row`);
        }
    });
});
