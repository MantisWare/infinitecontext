import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { SyncService } from './sync-service';
import type { SyncRepository, SyncAppendChangeInput } from './repository';
import type { SyncChangeRecord, SyncConflictRecord } from './types';
import { generatePublicId } from '../public-ids';
import { buildNodeInsertRecords } from '../context-chain';

let testClientSeq = 0;
const testClientId = () => {
    testClientSeq += 1;
    const hex = testClientSeq.toString(16).padStart(24, '0').slice(-24);
    return `icn_${hex}`;
};

class MemorySyncRepository implements SyncRepository {
    private head = 0;
    private changes: SyncChangeRecord[] = [];
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
        return row;
    }

    async listConflictsSince() {
        return [];
    }

    async touchSessionSync() {}

    async hasMessageClientMutationSince(
        _userId: number,
        contextId: string,
        sinceSequence: number,
        clientNodeIds: string[],
    ) {
        const targets = new Set(clientNodeIds);
        for (const change of this.changes) {
            if (change.context_id !== contextId) continue;
            if (change.sequence <= sinceSequence) continue;
            if (change.op !== 'message_update' && change.op !== 'message_delete') continue;
            for (const key of ['affected_client_ids', 'deleted_client_ids'] as const) {
                const list = change.payload[key];
                if (!Array.isArray(list)) continue;
                for (const id of list) {
                    if (typeof id === 'string' && targets.has(id)) return true;
                }
            }
        }
        return false;
    }
}

async function seedContextWithIcn(storage: MemoryStorage, projectId: number) {
    const icn = testClientId();
    const rootId = generatePublicId('context');
    await storage.insertNodes({
        public_id: rootId,
        project_id: projectId,
        type: 'context',
        context_id: null,
        parent_id: null,
        content: {},
        metadata: {},
    });
    const headId = generatePublicId('context');
    await storage.insertNodes({
        public_id: headId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: null,
        content: {},
        metadata: { operation: 'create' },
    });
    const records = buildNodeInsertRecords(
        [{ type: 'message', content: { text: 'one' }, metadata: { ic_client_node_id: icn } }],
        projectId,
        headId,
        null,
    );
    await storage.insertNodes(records);
    return { rootId, icn, msgPublicId: records[0]!.public_id };
}

describe('message_delete stale base with index/msg selectors', () => {
    it('conflicts when delete by index follows sync update on same icn', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('p');
        const syncRepo = new MemorySyncRepository();
        const service = new SyncService(storage, syncRepo);
        const ctx = { userId: 1, projectId: project!.id };

        const createClient = testClientId();
        const created = await service.pushMutations(ctx, [
            { client_id: createClient, op: 'context_create', payload: { metadata: { source: 't' } } },
        ]);
        const contextId = String(created.effects[0]?.context_id ?? '');
        const icn = testClientId();
        await service.pushMutations(ctx, [
            {
                client_id: testClientId(),
                op: 'message_append',
                context_id: contextId,
                payload: {
                    messages: [{ id: icn, role: 'user', content: { message: 'x' }, metadata: { ic_client_node_id: icn } }],
                },
            },
        ]);

        const baseSeq = await syncRepo.getHeadSequence(1);
        await service.pushMutations(ctx, [
            {
                client_id: testClientId(),
                op: 'message_update',
                context_id: contextId,
                payload: { updates: [{ id: icn, text: 'changed' }] },
            },
        ]);

        const delClient = testClientId();
        const del = await service.pushMutations(ctx, [
            {
                client_id: delClient,
                op: 'message_delete',
                context_id: contextId,
                base_sequence: baseSeq,
                payload: { ids: [0] },
            },
        ]);
        assert.ok(del.conflicts.some((c) => c.kind === 'delete_stale_base'));
        const read = await service.pullChanges(1, 0, 100);
        const delChange = read.changes.find((c) => c.client_id === delClient && c.op === 'message_delete');
        assert.ok(delChange?.payload?.conflict, 'delete mutation should be logged as conflict, not applied delete');
    });
});

describe('updateMessages affected_client_ids', () => {
    it('resolves index selector to ic_client_node_id', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('p');
        const { rootId, icn } = await seedContextWithIcn(storage, project!.id);
        const { updateMessages } = await import('../ops/update-messages');
        const result = await updateMessages(storage, project!.id, rootId, {
            updates: [{ index: 0, text: 'patched' }],
        });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.deepEqual(result.data.affected_client_ids, [icn]);
        }
    });
});
