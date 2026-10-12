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
    /** Stable cleartext nonce binding encrypted root metadata AAD (per context). */
    'ic_root_aad',
] as const;

/** AAD field for encrypting context root metadata (not message bodies). */
export const ROOT_METADATA_AAD_FIELD = 'context_root' as const;

export type CleartextMetadataKey = (typeof CLEARTEXT_METADATA_KEYS)[number];
