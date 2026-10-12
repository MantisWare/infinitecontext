import { computeDekProof, parseWrappedDekRecord, constantTimeEqual } from '@infinitecontext/crypto';

import type { AuthRepository, SessionRow, UserCryptoRow } from './types';

function buffersEqual(a: Buffer | null | undefined, b: Buffer | null | undefined): boolean {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}

export class VaultService {
    constructor(private readonly authRepo: AuthRepository) {}

    async getCryptoState(userId: number): Promise<UserCryptoRow | null> {
        return this.authRepo.findUserCrypto(userId);
    }

    async initializeCrypto(input: {
        userId: number;
        kdfSalt: Buffer;
        kdfParams: Record<string, unknown>;
        wrappedDek: Buffer;
        wrappedDekRecovery: Buffer;
        dekProofTag: Buffer;
        dekVersion: number;
        vaultPassphraseRequired: boolean;
        now?: string;
    }): Promise<UserCryptoRow> {
        const existing = await this.authRepo.findUserCrypto(input.userId);
        if (existing?.crypto_initialized_at) {
            throw new VaultError('already_initialized', 'Vault crypto is already initialized');
        }
        try {
            parseWrappedDekRecord(new Uint8Array(input.wrappedDek));
            parseWrappedDekRecord(new Uint8Array(input.wrappedDekRecovery));
        } catch {
            throw new VaultError('invalid_payload', 'Invalid wrapped DEK format');
        }
        const now = input.now ?? new Date().toISOString();
        return this.authRepo.upsertUserCrypto({
            userId: input.userId,
            kdfSalt: input.kdfSalt,
            kdfParams: input.kdfParams,
            wrappedDek: input.wrappedDek,
            wrappedDekRecovery: input.wrappedDekRecovery,
            dekProofTag: input.dekProofTag,
            dekVersion: input.dekVersion,
            cryptoInitializedAt: now,
            vaultPassphraseRequired: input.vaultPassphraseRequired,
        });
    }

    async updateWraps(input: {
        userId: number;
        kdfSalt?: Buffer;
        wrappedDek?: Buffer;
        wrappedDekRecovery?: Buffer;
        dekVersion?: number;
        dekProofTag?: Buffer;
        expectedWrappedDek?: Buffer;
        expectedWrappedDekRecovery?: Buffer;
    }): Promise<UserCryptoRow> {
        const existing = await this.authRepo.findUserCrypto(input.userId);
        if (!existing?.crypto_initialized_at) {
            throw new VaultError('not_initialized', 'Vault crypto is not initialized');
        }
        if (!input.dekProofTag || !existing.dek_proof_tag) {
            throw new VaultError('invalid_payload', 'dek_proof is required');
        }
        if (!buffersEqual(input.dekProofTag, existing.dek_proof_tag)) {
            throw new VaultError('invalid_payload', 'Invalid dek_proof');
        }

        if (input.wrappedDek) {
            if (!input.expectedWrappedDek || !existing.wrapped_dek) {
                throw new VaultError('invalid_payload', 'expected_wrapped_dek is required');
            }
            if (!buffersEqual(input.expectedWrappedDek, existing.wrapped_dek)) {
                throw new VaultError('wrap_conflict', 'Wrapped DEK changed since last read (compare-and-swap failed)');
            }
            try {
                parseWrappedDekRecord(new Uint8Array(input.wrappedDek));
            } catch {
                throw new VaultError('invalid_payload', 'Invalid wrapped DEK format');
            }
        }

        if (input.wrappedDekRecovery) {
            if (!input.expectedWrappedDekRecovery || !existing.wrapped_dek_recovery) {
                throw new VaultError('invalid_payload', 'expected_wrapped_dek_recovery is required');
            }
            if (!buffersEqual(input.expectedWrappedDekRecovery, existing.wrapped_dek_recovery)) {
                throw new VaultError('wrap_conflict', 'Recovery wrap changed since last read (compare-and-swap failed)');
            }
            try {
                parseWrappedDekRecord(new Uint8Array(input.wrappedDekRecovery));
            } catch {
                throw new VaultError('invalid_payload', 'Invalid recovery wrapped DEK format');
            }
        }

        if (input.dekVersion !== undefined && input.dekVersion !== existing.dek_version) {
            throw new VaultError('invalid_payload', 'dek_version cannot be changed via PATCH');
        }

        const updated = await this.authRepo.updateUserCryptoWraps({
            userId: input.userId,
            kdfSalt: input.kdfSalt,
            wrappedDek: input.wrappedDek,
            wrappedDekRecovery: input.wrappedDekRecovery,
            dekVersion: input.dekVersion,
            dekProofTag: input.dekProofTag,
            expectedWrappedDek: input.expectedWrappedDek,
            expectedWrappedDekRecovery: input.expectedWrappedDekRecovery,
            updatedAt: new Date().toISOString(),
        });
        if (!updated) throw new VaultError('not_initialized', 'Vault crypto is not initialized');
        return updated;
    }

    async listDevices(userId: number): Promise<SessionRow[]> {
        const sessions = await this.authRepo.listSessionsForUser(userId);
        return sessions.filter((s) => !s.revoked_at && Date.parse(s.expires_at) > Date.now());
    }

    async revokeDevice(userId: number, sessionPublicId: string): Promise<void> {
        const ok = await this.authRepo.revokeSessionByPublicId(userId, sessionPublicId, new Date().toISOString());
        if (!ok) throw new VaultError('device_not_found', 'Device session not found');
    }
}

export class VaultError extends Error {
    constructor(
        readonly code:
            | 'already_initialized'
            | 'not_initialized'
            | 'device_not_found'
            | 'invalid_payload'
            | 'wrap_conflict',
        message: string,
    ) {
        super(message);
        this.name = 'VaultError';
    }
}

export function serializeUserCryptoPublic(row: UserCryptoRow | null, user?: { password_hash: string | null }) {
    const passphraseRequired =
        Boolean(row?.vault_passphrase_required) ||
        (user?.password_hash === null || user?.password_hash === undefined);
    if (!row?.crypto_initialized_at) {
        return { initialized: false as const, vault_passphrase_required: passphraseRequired };
    }
    return {
        initialized: true as const,
        dek_version: row.dek_version,
        kdf_params: row.kdf_params,
        kdf_salt: row.kdf_salt ? row.kdf_salt.toString('base64') : null,
        wrapped_dek: row.wrapped_dek ? row.wrapped_dek.toString('base64') : null,
        wrapped_dek_recovery: row.wrapped_dek_recovery ? row.wrapped_dek_recovery.toString('base64') : null,
        vault_passphrase_required: passphraseRequired,
        crypto_initialized_at: row.crypto_initialized_at,
    };
}
