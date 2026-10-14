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

/** Upper bound on memorySizeKiB × iterations (65536×3 profile = 196608). */
/** 4× default profile cost (65536 KiB × 3 iterations). */
export const VAULT_KDF_MAX_COST_PRODUCT = 786_432;

export function assertVaultKdfCostWithinCap(params: VaultKdfParams): void {
    const product = params.memorySizeKiB * params.iterations;
    if (!Number.isSafeInteger(product) || product > VAULT_KDF_MAX_COST_PRODUCT) {
        throw new Error('vault.json kdf memorySizeKiB × iterations exceeds allowed cost cap');
    }
}

export async function deriveVaultKekWithParams(
    passphrase: string,
    salt: Uint8Array,
    kdfParams: VaultKdfParams = VAULT_KDF_PARAMS,
): Promise<Uint8Array> {
    assertVaultKdfCostWithinCap(kdfParams);
    const hash = await argon2id({
        password: passphrase,
        salt,
        parallelism: kdfParams.parallelism,
        iterations: kdfParams.iterations,
        memorySize: kdfParams.memorySizeKiB,
        hashLength: kdfParams.hashLength,
        outputType: 'binary',
    });
    return hash instanceof Uint8Array ? hash : new Uint8Array(hash);
}

export async function deriveVaultKek(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    return deriveVaultKekWithParams(passphrase, salt, VAULT_KDF_PARAMS);
}

/** Recovery key material is used directly as a 256-bit KEK (high entropy). */
export function recoveryKeyToKek(recoveryKeyBytes: Uint8Array): Uint8Array {
    if (recoveryKeyBytes.length !== 32) throw new Error('Recovery key must be 32 bytes');
    return new Uint8Array(recoveryKeyBytes);
}
