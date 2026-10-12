/** Placeholder used in docs/OpenAPI — not a runtime default. */
export const DOCS_API_BASE_URL_PLACEHOLDER = 'https://your-api.example.com';

export const KEYS_AND_SERVICES_DOC_URL =
    'https://docs.infinitecontext.ai/configuration/keys-and-services';

export class MissingClientConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MissingClientConfigError';
    }
}

export function resolveRequiredBaseUrl(cfg: { baseUrl?: string }, env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): string {
    const fromEnv = String(env.INFINITECONTEXT_BASE_URL ?? '').trim();
    const fromCfg = String(cfg.baseUrl ?? '').trim();
    const resolved = (fromEnv || fromCfg).replace(/\/+$/, '');
    if (!resolved) {
        throw new MissingClientConfigError(
            `API base URL is required. Set INFINITECONTEXT_BASE_URL or run: infinitecontext config set server <url>\n` +
                `See ${KEYS_AND_SERVICES_DOC_URL}`,
        );
    }
    return resolved;
}
