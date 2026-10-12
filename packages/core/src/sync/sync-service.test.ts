import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { SyncService } from './sync-service';
import type { SyncRepository, SyncAppendChangeInput } from './repository';
import type { SyncChangeRecord, SyncConflictRecord } from './types';
let testClientSeq = 0;
const testClientId = () => {
    testClientSeq += 1;
    const hex = testClientSeq.toString(16).padStart(24, '0').slice(-24);
    return `icn_${hex}`;
};

class MemorySyncRepository implements SyncRepository {
    private head = 0;
    private changes: SyncChangeRecord[] = [];
    private conflicts: SyncConflictRecord[] = [];
    private byClient = new Map<string, number>();

    async getHeadSequence(_userId: number) {
        return this.head;
    }

    async findChangeByClientId(_userId: number, clientId: string) {
        const seq = this.byClient.get(clientId);
        if (seq === undefined) return null;
        const row = this.changes.find((c) => c.sequence === seq);
        if (!row) return null;
        return { sequence: row.sequence, payload: row.payload, op: row.op };
    }

    async appendChange(input: SyncAppendChangeInput) {
        this.head += 1;
        this.byClient.set(input.clientId, this.head);
        this.changes.push({
            sequence: this.head,
            op: input.op as SyncChangeRecord['op'],
            context_id: input.contextId,
            client_id: input.clientId,
            payload: input.payload,
            device_id: input.deviceId ?? null,
            created_at: new Date().toISOString(),
        });
        return this.head;
    }

    async listChanges(_userId: number, since: number, limit: number) {
        return this.changes.filter((c) => c.sequence > since).slice(0, limit);
    }

    async insertConflict(input: {
        userId: number;
        contextId: string;
        kind: string;
        clientId: string | null;
        sequence: number;
        publicId: string;
        leftPayload: Record<string, unknown>;
        rightPayload: Record<string, unknown>;
    }) {
        const row: SyncConflictRecord = {
            id: input.publicId,
            context_id: input.contextId,
            kind: input.kind,
            client_id: input.clientId,
            sequence: input.sequence,
            left_payload: input.leftPayload,
            right_payload: input.rightPayload,
            created_at: new Date().toISOString(),
            resolved_at: null,
        };
        this.conflicts.push(row);
        return row;
    }

    async listConflictsSince(_userId: number, sinceSequence: number, limit: number) {
        return this.conflicts.filter((c) => c.sequence > sinceSequence).slice(0, limit);
    }

    async touchSessionSync() {}
}

describe('SyncService', () => {
    it('push is idempotent on client_id and pull returns ordered changes', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('p');
        const syncRepo = new MemorySyncRepository();
        const service = new SyncService(storage, syncRepo);
        const ctx = { userId: 1, projectId: project!.id };

        const clientId = testClientId();
        const push1 = await service.pushMutations(ctx, [
            {
                client_id: clientId,
                op: 'context_create',
                payload: { metadata: { source: 'test', user_id: 'u1' } },
            },
        ]);
        assert.equal(push1.applied.length, 1);
        assert.equal(push1.duplicate.length, 0);

        const pushDup = await service.pushMutations(ctx, [
            {
                client_id: clientId,
                op: 'context_create',
                payload: { metadata: { source: 'test', user_id: 'u1' } },
            },
        ]);
        assert.equal(pushDup.duplicate.length, 1);
        assert.equal(pushDup.applied.length, 0);

        const pull = await service.pullChanges(1, 0, 100);
        assert.equal(pull.changes.length, 1);
        assert.equal(pull.changes[0]?.op, 'context_create');
    });

    it('returns per-item failed for message_delete without base_sequence', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('p');
        const syncRepo = new MemorySyncRepository();
        const service = new SyncService(storage, syncRepo);
        const ctx = { userId: 1, projectId: project!.id };

        const createId = testClientId();
        const created = await service.pushMutations(ctx, [
            {
                client_id: createId,
                op: 'context_create',
                payload: { metadata: { source: 'test' } },
            },
        ]);
        const contextId = String(created.effects[0]?.context_id ?? '');
        assert.ok(contextId.startsWith('ctx_'));
        const m1 = testClientId();
        await service.pushMutations(ctx, [
            {
                client_id: m1,
                op: 'message_append',
                context_id: contextId,
                payload: {
                    messages: [{ id: m1, role: 'user', content: { message: 'hi' }, metadata: { ic_client_node_id: m1 } }],
                },
            },
        ]);

        const delClient = testClientId();
        const result = await service.pushMutations(ctx, [
            {
                client_id: delClient,
                op: 'message_delete',
                context_id: contextId,
                payload: { ids: [m1] },
            },
        ]);
        assert.ok(result.failed?.some((f) => f.code === 'invalid_input' && f.client_id === delClient));
        assert.equal(result.applied.includes(delClient), false);
    });
});
