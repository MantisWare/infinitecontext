import { hashKey } from '@infinitecontext/core';

export function generateRefreshToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return `ic_rt_${Buffer.from(bytes).toString('base64url')}`;
}

export function generateOpaqueToken(prefix: string): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return `${prefix}_${Buffer.from(bytes).toString('base64url')}`;
}

export async function hashRefreshToken(token: string): Promise<string> {
    return hashKey(token);
}

export async function hashOpaqueToken(token: string): Promise<string> {
    return hashKey(token);
}
