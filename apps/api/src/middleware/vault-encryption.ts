import {
    contextRootMetadata,
    deleteBodyMetadata,
    extractMessageWrites,
    isClientNodeId,
    isVaultMessageWriteId,
    isEncryptedContent,
    isEncryptedWritePayload,
    metadataHasSensitivePlaintext,
} from '@infinitecontext/crypto';
import type { AuthRepository } from '@infinitecontext/auth';

import type { HttpContext } from '../types/http';

export type VaultEncryptionDeps = {
    authRepo: AuthRepository;
};

async function loadVaultPolicy(authRepo: AuthRepository, userId: number, passwordHash: string | null) {
    const crypto = await authRepo.findUserCrypto(userId);
    const initialized = Boolean(crypto?.crypto_initialized_at);
    const setupRequired =
        !initialized &&
        (Boolean(crypto?.vault_passphrase_required) || passwordHash === null || passwordHash === undefined);
    return { initialized, setupRequired };
}

function reject(c: HttpContext, status: 403 | 422, message: string) {
    return c.json({ error: message, code: status === 403 ? 'vault_setup_required' : 'plaintext_forbidden' }, status);
}

async function validateInitializedVaultWrites(
    c: HttpContext,
    deps: VaultEncryptionDeps,
    body: unknown,
    mode: 'create_root' | 'messages',
    { newMessageIdsOnly = false }: { newMessageIdsOnly?: boolean } = {},
): Promise<Response | null> {
    const auth = c.get('auth');
    if (auth.kind !== 'user_session') return null;

    const user = await deps.authRepo.findUserById(auth.userId);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const policy = await loadVaultPolicy(deps.authRepo, auth.userId, user.password_hash);
    if (policy.setupRequired) {
        return reject(c, 403, 'Vault setup required. Initialize your vault before writing context data.');
    }

    if (!policy.initialized) return null;

    if (mode === 'create_root') {
        const metadata = contextRootMetadata(body);
        if (metadataHasSensitivePlaintext(metadata)) {
            return reject(c, 422, 'Encrypted vault accounts must send sensitive metadata inside ic_sensitive.');
        }
        return null;
    }

    const writes = extractMessageWrites(body);
    for (const write of writes) {
        if (!write.clientNodeId || !isVaultMessageWriteId(write.clientNodeId)) {
            return reject(
                c,
                422,
                'Vault message writes must include `id` (icn_* for new messages or msg_* when updating by id).',
            );
        }
        if (newMessageIdsOnly && !isClientNodeId(write.clientNodeId)) {
            return reject(c, 422, 'New message ids must be icn_ followed by 24 lowercase hex digits.');
        }
        if (!isClientNodeId(write.metadata.ic_client_node_id)) {
            return reject(c, 422, 'metadata.ic_client_node_id must be set to the stable icn_* client node id.');
        }
        if (isClientNodeId(write.clientNodeId) && write.metadata.ic_client_node_id !== write.clientNodeId) {
            return reject(c, 422, 'For new messages, metadata.ic_client_node_id must match id.');
        }
        if (!isEncryptedWritePayload(write.content, write.metadata)) {
            return reject(
                c,
                422,
                'Encrypted vault accounts must send ciphertext payloads only (strict __ic_enc envelope).',
            );
        }
        if (metadataHasSensitivePlaintext(write.metadata)) {
            return reject(c, 422, 'Encrypted vault accounts must send sensitive metadata inside ic_sensitive.');
        }
    }
    return null;
}

export async function validateVaultMessageRead(
    c: HttpContext,
    deps: VaultEncryptionDeps,
    body: { data?: Array<Record<string, unknown>> },
    { allowLegacyMigrateRead = false }: { allowLegacyMigrateRead?: boolean } = {},
): Promise<Response | null> {
    const auth = c.get('auth');
    if (auth.kind !== 'user_session') return null;

    const user = await deps.authRepo.findUserById(auth.userId);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const policy = await loadVaultPolicy(deps.authRepo, auth.userId, user.password_hash);
    if (!policy.initialized) return null;

    const rows = body.data ?? [];
    if (rows.length === 0) return null;

    const encryptedCount = rows.filter((row) => isEncryptedContent(row)).length;
    if (allowLegacyMigrateRead && encryptedCount === 0) {
        return null;
    }
    if (encryptedCount !== rows.length) {
        return reject(
            c,
            422,
            encryptedCount === 0
                ? 'Vault accounts cannot read plaintext message payloads. Run migrate-encrypt to converge.'
                : 'Vault context contains a mix of plaintext and encrypted messages. Run migrate-encrypt to converge.',
        );
    }

    return null;
}

export async function validateVaultContextWrite(
    c: HttpContext,
    deps: VaultEncryptionDeps,
    body: unknown,
    mode: 'create_root' | 'messages',
    options?: { newMessageIdsOnly?: boolean },
): Promise<Response | null> {
    return validateInitializedVaultWrites(c, deps, body, mode, options);
}

export async function validateVaultHistoricalRead(
    c: HttpContext,
    deps: VaultEncryptionDeps,
    query: { version?: string; at?: string; before?: string },
    body: { data?: Array<Record<string, unknown>> },
): Promise<Response | null> {
    const isHistorical = query.version !== undefined || query.at !== undefined || query.before !== undefined;
    if (!isHistorical) return null;

    const auth = c.get('auth');
    if (auth.kind !== 'user_session') return null;

    const user = await deps.authRepo.findUserById(auth.userId);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const policy = await loadVaultPolicy(deps.authRepo, auth.userId, user.password_hash);
    if (!policy.initialized) return null;

    const allowLegacyMigrateRead = c.req.header('x-ic-vault-migrate-read') === '1';
    return validateVaultMessageRead(c, deps, body, { allowLegacyMigrateRead });
}

export async function validateVaultDeleteWrite(
    c: HttpContext,
    deps: VaultEncryptionDeps,
    body: unknown,
): Promise<Response | null> {
    const metadata = deleteBodyMetadata(body);
    if (!metadata) return null;
    return validateInitializedVaultWrites(c, deps, { metadata }, 'create_root');
}
