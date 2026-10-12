import { argon2Verify, argon2id } from 'hash-wasm';

/** Server-side login password hashing (NOT vault KEK derivation — see plan §7.1). */
export const AUTH_PASSWORD_ARGON2 = {
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    saltLength: 16,
} as const;

export async function hashAuthPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(AUTH_PASSWORD_ARGON2.saltLength));
    return argon2id({
        password,
        salt,
        parallelism: AUTH_PASSWORD_ARGON2.parallelism,
        iterations: AUTH_PASSWORD_ARGON2.iterations,
        memorySize: AUTH_PASSWORD_ARGON2.memorySize,
        hashLength: AUTH_PASSWORD_ARGON2.hashLength,
        outputType: 'encoded',
    });
}

export async function verifyAuthPassword(password: string, stored: string): Promise<boolean> {
    try {
        return await argon2Verify({ password, hash: stored });
    } catch {
        return false;
    }
}
