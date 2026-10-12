import { argon2id } from 'hash-wasm';

import { VAULT_KDF_PARAMS } from './constants';

export type VaultKdfParams = {
    algorithm: 'argon2id';
    memorySizeKiB: number;
    iterations: number;
    parallelism: number;
    hashLength: number;
};

export function serializeKdfParams(): VaultKdfParams {
    return {
        algorithm: VAULT_KDF_PARAMS.algorithm,
        memorySizeKiB: VAULT_KDF_PARAMS.memorySizeKiB,
        iterations: VAULT_KDF_PARAMS.iterations,
        parallelism: VAULT_KDF_PARAMS.parallelism,
        hashLength: VAULT_KDF_PARAMS.hashLength,
    };
}

export async function deriveVaultKek(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    const hash = await argon2id({
        password: passphrase,
        salt,
        parallelism: VAULT_KDF_PARAMS.parallelism,
        iterations: VAULT_KDF_PARAMS.iterations,
        memorySize: VAULT_KDF_PARAMS.memorySizeKiB,
        hashLength: VAULT_KDF_PARAMS.hashLength,
        outputType: 'binary',
    });
    return hash instanceof Uint8Array ? hash : new Uint8Array(hash);
}

/** Recovery key material is used directly as a 256-bit KEK (high entropy). */
export function recoveryKeyToKek(recoveryKeyBytes: Uint8Array): Uint8Array {
    if (recoveryKeyBytes.length !== 32) throw new Error('Recovery key must be 32 bytes');
    return new Uint8Array(recoveryKeyBytes);
}
