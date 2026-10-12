import type { StorageAdapter } from '@infinitecontext/core';
import type { AuthRepository } from '@infinitecontext/auth';

import {
    validateVaultContextWrite,
    validateVaultEncryptedMessageWriteToContext,
    validateVaultDeleteWrite,
    validateVaultPrunePlaintextVersions,
    type VaultEncryptionDeps,
} from '../middleware/vault-encryption';
import type { HttpContext } from '../types/http';

type SyncMutationLike = {
    op: string;
    context_id?: string;
    payload?: unknown;
};

function payloadMessages(payload: unknown): unknown {
    if (payload && typeof payload === 'object' && 'messages' in (payload as object)) {
        return (payload as { messages: unknown }).messages;
    }
    if (payload && typeof payload === 'object' && 'data' in (payload as object)) {
        return (payload as { data: unknown }).data;
    }
    return payload;
}

export async function validateVaultSyncPush(
    c: HttpContext,
    deps: VaultEncryptionDeps,
    storage: StorageAdapter,
    projectId: number,
    mutations: SyncMutationLike[],
): Promise<Response | null> {
    for (const mutation of mutations) {
        if (mutation.op === 'context_create' || mutation.op === 'context_fork') {
            const denied = await validateVaultContextWrite(c, deps, { metadata: (mutation.payload as any)?.metadata }, 'create_root');
            if (denied) return denied;
            continue;
        }

        if (mutation.op === 'context_metadata') {
            const metadata =
                mutation.payload && typeof mutation.payload === 'object' && 'metadata' in (mutation.payload as object)
                    ? (mutation.payload as { metadata?: unknown }).metadata
                    : mutation.payload;
            const denied = await validateVaultContextWrite(c, deps, { metadata }, 'create_root');
            if (denied) return denied;
            continue;
        }

        if (mutation.op === 'contexts_delete_many') {
            const denied = await validateVaultDeleteWrite(c, deps, mutation.payload ?? {});
            if (denied) return denied;
            continue;
        }

        const contextId = mutation.context_id;
        if (!contextId) {
            return c.json({ error: 'context_id required for this sync op' }, 400);
        }

        if (mutation.op === 'message_append') {
            const messages = payloadMessages(mutation.payload);
            const deniedMigrate = await validateVaultEncryptedMessageWriteToContext(c, deps, storage, projectId, contextId);
            if (deniedMigrate) return deniedMigrate;
            const denied = await validateVaultContextWrite(c, deps, messages, 'messages', { newMessageIdsOnly: true });
            if (denied) return denied;
            continue;
        }

        if (mutation.op === 'message_update' || mutation.op === 'message_delete') {
            const deniedMigrate = await validateVaultEncryptedMessageWriteToContext(c, deps, storage, projectId, contextId);
            if (deniedMigrate) return deniedMigrate;
            const body = payloadMessages(mutation.payload);
            const denied = await validateVaultContextWrite(c, deps, body, 'messages');
            if (denied) return denied;
            continue;
        }

        if (mutation.op === 'context_delete') {
            const denied = await validateVaultDeleteWrite(c, deps, mutation.payload ?? {});
            if (denied) return denied;
            continue;
        }

        if (mutation.op === 'prune_plaintext_versions') {
            const denied = await validateVaultPrunePlaintextVersions(c, deps, storage, projectId, contextId);
            if (denied) return denied;
        }
    }
    return null;
}

export type { VaultEncryptionDeps, AuthRepository };
