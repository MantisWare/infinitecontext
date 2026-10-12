export const HOSTED_API_BASE_URL = 'https://api.infinitecontext.ai';

export const DOCS_API_BASE_URL_PLACEHOLDER = 'https://your-api.example.com';

export const KEYS_AND_SERVICES_DOC_URL =
    'https://docs.infinitecontext.ai/configuration/keys-and-services';

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
