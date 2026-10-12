import type { StorageAdapter } from '@infinitecontext/core';
import type { AuthRepository } from '@infinitecontext/auth';

import {
    validateVaultContextWrite,
    validateVaultEncryptedMessageWriteToContext,
    type VaultEncryptionDeps,
} from '../middleware/vault-encryption';
import type { HttpContext } from '../types/http';

type SyncMutationLike = {
    op: string;
    context_id?: string;
    payload?: unknown;
};

export async function validateVaultSyncPush(
    c: HttpContext,
    deps: VaultEncryptionDeps,
    storage: StorageAdapter,
    projectId: number,
    mutations: SyncMutationLike[],
): Promise<Response | null> {
    for (const mutation of mutations) {
        if (mutation.op === 'context_create') {
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

        if (mutation.op === 'message_append') {
            const contextId = mutation.context_id;
            if (!contextId) {
                return c.json({ error: 'context_id required for message_append' }, 400);
            }
            const messages =
                mutation.payload && typeof mutation.payload === 'object' && 'messages' in (mutation.payload as object)
                    ? (mutation.payload as { messages: unknown }).messages
                    : mutation.payload;
            const deniedMigrate = await validateVaultEncryptedMessageWriteToContext(
                c,
                deps,
                storage,
                projectId,
                contextId,
            );
            if (deniedMigrate) return deniedMigrate;
            const denied = await validateVaultContextWrite(c, deps, messages, 'messages', { newMessageIdsOnly: true });
            if (denied) return denied;
        }
    }
    return null;
}

export type { VaultEncryptionDeps, AuthRepository };
