import type { StorageAdapter } from '../storage';
import type { SyncChangeRecord, SyncConflictRecord } from './types';

export type SyncAppendChangeInput = {
    userId: number;
    op: string;
    contextId: string | null;
    clientId: string;
    payload: Record<string, unknown>;
    deviceId?: string | null;
};

export interface SyncRepository {
    getHeadSequence(userId: number): Promise<number>;
    findChangeByClientId(
        userId: number,
        clientId: string,
    ): Promise<{ sequence: number; payload: Record<string, unknown>; op: string } | null>;
    appendChange(input: SyncAppendChangeInput): Promise<number>;
    listChanges(userId: number, since: number, limit: number): Promise<SyncChangeRecord[]>;
    insertConflict(input: {
        userId: number;
        contextId: string;
        kind: string;
        clientId: string | null;
        sequence: number;
        publicId: string;
        leftPayload: Record<string, unknown>;
        rightPayload: Record<string, unknown>;
    }): Promise<SyncConflictRecord>;
    listConflictsSince(userId: number, sinceSequence: number, limit: number): Promise<SyncConflictRecord[]>;
    touchSessionSync(sessionId: number, at: string): Promise<void>;
}

export type SyncStorageTransactionContext = {
    storage: StorageAdapter;
    appendChange(input: SyncAppendChangeInput): Promise<number>;
    insertConflict(input: {
        userId: number;
        contextId: string;
        kind: string;
        clientId: string | null;
        sequence: number;
        publicId: string;
        leftPayload: Record<string, unknown>;
        rightPayload: Record<string, unknown>;
    }): Promise<SyncConflictRecord>;
};

export interface TransactionalSyncRepository extends SyncRepository {
    runStorageTransaction<T>(fn: (ctx: SyncStorageTransactionContext) => Promise<T>): Promise<T>;
}
