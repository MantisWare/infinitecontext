export {
    DOCS_API_BASE_URL_PLACEHOLDER,
    HOSTED_API_BASE_URL,
    KEYS_AND_SERVICES_DOC_URL,
} from '../lib/client-config.mjs';

import { HOSTED_API_BASE_URL } from '../lib/client-config.mjs';

export class MissingClientConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MissingClientConfigError';
    }
}

function normalizeBaseUrl(url: string): string {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

export function resolveBaseUrlFromConfig(
    cfg: { baseUrl?: string },
    env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
    const fromEnv = String(env.INFINITECONTEXT_BASE_URL ?? '').trim();
    const fromCfg = String(cfg.baseUrl ?? '').trim();
    return normalizeBaseUrl(fromEnv || fromCfg || HOSTED_API_BASE_URL);
}

/** @deprecated alias */
export function resolveRequiredBaseUrl(
    cfg: { baseUrl?: string },
    env?: Record<string, string | undefined>,
): string {
    return resolveBaseUrlFromConfig(cfg, env);
}
