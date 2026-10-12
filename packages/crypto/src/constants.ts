/** Vault passphrase → KEK (client-only; separate from server login password hashing). */
export const VAULT_KDF_PARAMS = {
    algorithm: 'argon2id' as const,
    memorySizeKiB: 65536,
    iterations: 3,
    parallelism: 4,
    hashLength: 32,
    saltLength: 16,
};

export const RECOVERY_KEY_BYTES = 32;

export const DEK_BYTES = 32;

export const ENVELOPE_VERSION = 1 as const;

export const AEAD_ALG = 'XC20P' as const;

export const WRAP_ALG = 'XC20P' as const;

/** Metadata keys kept in cleartext for server-side list filters (plan §3.2). */
export const CLEARTEXT_METADATA_KEYS = [
    'source',
    'user_id',
    'host',
    'project_path',
    'session_id',
] as const;

export type CleartextMetadataKey = (typeof CLEARTEXT_METADATA_KEYS)[number];
