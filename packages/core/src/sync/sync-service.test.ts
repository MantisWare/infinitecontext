import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { SyncService } from './sync-service';
import type { SyncRepository, SyncAppendChangeInput } from './repository';
import type { SyncChangeRecord, SyncConflictRecord } from './types';
const testClientId = () => `icn_${'a'.repeat(24)}`;

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
});
