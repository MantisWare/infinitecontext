import {
    contextRootMetadata,
    deleteBodyMetadata,
    extractMessageWrites,
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
        if (!isEncryptedWritePayload(write.content, write.metadata)) {
            return reject(
                c,
                422,
                'Encrypted vault accounts must send ciphertext payloads only (strict __ic_enc envelope).',
            );
        }
    }
    return null;
}

export async function validateVaultContextWrite(
    c: HttpContext,
    deps: VaultEncryptionDeps,
    body: unknown,
    mode: 'create_root' | 'messages',
): Promise<Response | null> {
    return validateInitializedVaultWrites(c, deps, body, mode);
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
