import { DEK_BYTES, RECOVERY_KEY_BYTES } from './constants';
import { encodeRecoveryKey, randomBytes } from './encoding';
import { wrapDek } from './dek-wrap';
import { deriveVaultKek, recoveryKeyToKek, serializeKdfParams } from './kdf';

export type VaultInitMaterial = {
    dek: Uint8Array;
    recoveryKeyBytes: Uint8Array;
    recoveryKeyDisplay: string;
    kdfSalt: Uint8Array;
    kdfParams: ReturnType<typeof serializeKdfParams>;
    wrappedDekPassphrase: Uint8Array;
    wrappedDekRecovery: Uint8Array;
    dekVersion: number;
};

export async function createVaultCryptoMaterial(passphrase: string): Promise<VaultInitMaterial> {
    const dek = randomBytes(DEK_BYTES);
    const recoveryKeyBytes = randomBytes(RECOVERY_KEY_BYTES);
    const kdfSalt = randomBytes(16);
    const kekPass = await deriveVaultKek(passphrase, kdfSalt);
    const kekRecovery = recoveryKeyToKek(recoveryKeyBytes);

    return {
        dek,
        recoveryKeyBytes,
        recoveryKeyDisplay: encodeRecoveryKey(recoveryKeyBytes),
        kdfSalt,
        kdfParams: serializeKdfParams(),
        wrappedDekPassphrase: wrapDek(dek, kekPass),
        wrappedDekRecovery: wrapDek(dek, kekRecovery),
        dekVersion: 1,
    };
}

export async function rewrapDekWithNewPassphrase(input: {
    dek: Uint8Array;
    newPassphrase: string;
    kdfSalt: Uint8Array;
}): Promise<Uint8Array> {
    const kek = await deriveVaultKek(input.newPassphrase, input.kdfSalt);
    return wrapDek(input.dek, kek);
}

export async function rotateRecoveryWrap(input: {
    dek: Uint8Array;
    newRecoveryKeyBytes: Uint8Array;
}): Promise<{ recoveryKeyDisplay: string; wrappedDekRecovery: Uint8Array }> {
    const kek = recoveryKeyToKek(input.newRecoveryKeyBytes);
    return {
        recoveryKeyDisplay: encodeRecoveryKey(input.newRecoveryKeyBytes),
        wrappedDekRecovery: wrapDek(input.dek, kek),
    };
}
