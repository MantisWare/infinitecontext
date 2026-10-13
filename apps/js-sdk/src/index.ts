import { resolveBaseUrlFromConfig } from './base-url';

export type InfiniteContextConfig = {
    apiKey?: string;
    accessToken?: string;
    getAccessToken?: () => Promise<string>;
    baseUrl?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    timeoutMs?: number;
};

export type Version = {
    version: number;
    created_at: string;
    operation: 'create' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

export type CreateContextInput = {
    from?: string;
    version?: number;
    at?: number;
    before?: string;
    metadata?: Record<string, unknown>;
};

export type CreateContextResponse = {
    id: string;
    metadata: Record<string, unknown>;
    created_at: string;
};

export type AppendMessage = Omit<Record<string, unknown>, 'metadata'> & { metadata?: Record<string, unknown> };
export type AppendInput = AppendMessage | AppendMessage[];

export type AppendResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
};

export type GetContextInput = {
    version?: number;
    at?: number;
    before?: string;
    history?: boolean;
    /** One-time plaintext read for vault migrate-encrypt tooling (sets X-IC-Vault-Migrate-Read). */
    vaultMigrateRead?: boolean;
};

export type GetContextResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
    metadata?: Record<string, unknown>;
    versions?: Version[];
    /** Sync log sequence at read time; pass as base_sequence on PATCH/DELETE when session sync is enabled. */
    sync_base_sequence?: number;
};

export type ListContextsInput = {
    limit?: number;
    source?: string;
    user_id?: string;
    host?: string;
    project_path?: string;
    session_id?: string;
    after?: string;
    before?: string;
};

export type ListContextsResponse = {
    data: Array<{
        id: string;
        metadata: Record<string, unknown>;
        created_at: string;
    }>;
};

export type MutationOptions = {
    metadata?: Record<string, unknown>;
    /** Last-seen sync sequence (from GET context or pull cursor). Required for session-sync message delete. */
    base_sequence?: number;
};

export type UpdateMessageInput =
    | ({ id: string; index?: never } & Record<string, unknown>)
    | ({ index: number; id?: never } & Record<string, unknown>);
export type UpdateInput = UpdateMessageInput | UpdateMessageInput[];

export type UpdateResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
    sync_base_sequence?: number;
};

export type DeleteInput = (string | number) | (string | number)[];

// Unified delete input — either message ids (soft, versioned) OR {permanent: true} (hard, irreversible)
export type DeletePermanentInput = { permanent: true; metadata?: Record<string, unknown> };

export type DeleteResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
    sync_base_sequence?: number;
};

export type PermanentDeleteResponse = {
    deleted: boolean;
    id: string;
    metadata?: Record<string, unknown>;
};

export type DeleteManyResult = {
    id: string;
    deleted: boolean;
    error?: string;
};

export type DeleteManyResponse = {
    results: DeleteManyResult[];
    deleted_count: number;
};

export {
    DOCS_API_BASE_URL_PLACEHOLDER,
    HOSTED_API_BASE_URL,
    KEYS_AND_SERVICES_DOC_URL,
    MissingClientConfigError,
    resolveBaseUrlFromConfig,
} from './base-url';

function mutationBaseHeaders(options?: MutationOptions): Record<string, string> | undefined {
    if (options?.base_sequence === undefined) return undefined;
    return { 'X-IC-Base-Sequence': String(options.base_sequence) };
}

export class InfiniteContextHttpError extends Error {
    readonly status: number;
    readonly url: string;
    readonly bodyText?: string;

    constructor(args: { status: number; url: string; bodyText?: string }) {
        super(`InfiniteContext request failed: ${args.status} ${args.url}`);
        this.name = 'InfiniteContextHttpError';
        this.status = args.status;
        this.url = args.url;
        this.bodyText = args.bodyText;
    }
}

export class InfiniteContext {
    private readonly baseUrl: string;
    private readonly apiKey?: string;
    private readonly accessToken?: string;
    private readonly getAccessTokenFn?: () => Promise<string>;
    private readonly fetchFn: typeof fetch;
    private readonly headers?: Record<string, string>;
    private readonly timeoutMs?: number;
    /** Last sync_base_sequence from GET /contexts/:id or append — not updated by PATCH. */
    private lastSyncBaseSequence: number | null = null;

    constructor(cfg: InfiniteContextConfig) {
        this.baseUrl = resolveBaseUrlFromConfig(cfg);
        this.apiKey = cfg.apiKey;
        this.accessToken = cfg.accessToken;
        this.getAccessTokenFn = cfg.getAccessToken;
        if (!this.apiKey && !this.accessToken && !this.getAccessTokenFn) {
            throw new Error('InfiniteContext requires apiKey, accessToken, or getAccessToken');
        }
        this.fetchFn = cfg.fetch ?? fetch;
        this.headers = cfg.headers;
        this.timeoutMs = cfg.timeoutMs;
    }

    async create(input: CreateContextInput = {}): Promise<CreateContextResponse> {
        return this.request<CreateContextResponse>('/contexts', {
            method: 'POST',
            body: input,
        });
    }

    async append<T = unknown>(contextId: string, input: AppendInput): Promise<AppendResponse<T>> {
        const res = await this.request<AppendResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'POST',
            body: input,
        });
        this.captureSyncBaseFromRead(res);
        return res;
    }

    async get(options?: ListContextsInput): Promise<ListContextsResponse>;
    async get<T = unknown>(id: string, options?: GetContextInput): Promise<GetContextResponse<T>>;
    async get<T = unknown>(
        idOrOptions?: string | ListContextsInput,
        options?: GetContextInput
    ): Promise<GetContextResponse<T> | ListContextsResponse> {
        if (!idOrOptions || typeof idOrOptions === 'object') {
            const params = new URLSearchParams();
            if (typeof idOrOptions === 'object') {
                if (idOrOptions.limit) params.set('limit', String(idOrOptions.limit));
                if (idOrOptions.source) params.set('source', idOrOptions.source);
                if (idOrOptions.user_id) params.set('user_id', idOrOptions.user_id);
                if (idOrOptions.host) params.set('host', idOrOptions.host);
                if (idOrOptions.project_path) params.set('project_path', idOrOptions.project_path);
                if (idOrOptions.session_id) params.set('session_id', idOrOptions.session_id);
                if (idOrOptions.after) params.set('after', idOrOptions.after);
                if (idOrOptions.before) params.set('before', idOrOptions.before);
            }
            const query = params.toString();
            return this.request<ListContextsResponse>(`/contexts${query ? `?${query}` : ''}`, { method: 'GET' });
        }

        const params = new URLSearchParams();
        if (options?.version !== undefined) params.set('version', String(options.version));
        if (options?.at !== undefined) params.set('at', String(options.at));
        if (options?.before) params.set('before', options.before);
        if (options?.history) params.set('history', 'true');
        const query = params.toString();
        const res = await this.request<GetContextResponse<T>>(
            `/contexts/${encodeURIComponent(idOrOptions)}${query ? `?${query}` : ''}`,
            {
                method: 'GET',
                headers: options?.vaultMigrateRead ? { 'X-IC-Vault-Migrate-Read': '1' } : undefined,
            },
        );
        this.captureSyncBaseFromRead(res);
        return res;
    }

    async update<T = unknown>(contextId: string, input: UpdateInput, options?: MutationOptions): Promise<UpdateResponse<T>> {
        let body: Record<string, unknown> =
            options?.metadata !== undefined
                ? { updates: Array.isArray(input) ? input : [input], metadata: options.metadata }
                : (input as Record<string, unknown>);
        const baseSequence = options?.base_sequence ?? this.lastSyncBaseSequence ?? undefined;
        if (baseSequence !== undefined) {
            body = { ...body, base_sequence: baseSequence };
        }

        return this.request<UpdateResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'PATCH',
            body,
            headers: mutationBaseHeaders({ ...options, base_sequence: baseSequence }),
        });
    }

    async delete<T = unknown>(contextId: string, ids: DeleteInput, options?: MutationOptions): Promise<DeleteResponse<T>>;
    async delete(contextId: string, input: DeletePermanentInput): Promise<PermanentDeleteResponse>;
    async delete<T = unknown>(
        contextId: string,
        input: DeleteInput | DeletePermanentInput,
        options?: MutationOptions,
    ): Promise<DeleteResponse<T> | PermanentDeleteResponse> {
        const isPermanent =
            typeof input === 'object' &&
            !Array.isArray(input) &&
            input !== null &&
            (input as DeletePermanentInput).permanent === true;

        if (isPermanent) {
            const meta = (input as DeletePermanentInput).metadata;
            return this.request<PermanentDeleteResponse>(`/contexts/${encodeURIComponent(contextId)}`, {
                method: 'DELETE',
                body: meta ? { permanent: true, metadata: meta } : { permanent: true },
            });
        }

        const baseSequence = options?.base_sequence ?? this.lastSyncBaseSequence ?? undefined;
        if (this.usesSessionSync() && baseSequence === undefined) {
            throw new Error(
                'base_sequence is required for message delete — run sync pull or GET /contexts/:id first, or pass options.base_sequence',
            );
        }

        const body: Record<string, unknown> = {
            ids: input as DeleteInput,
            metadata: options?.metadata,
        };
        if (baseSequence !== undefined) body.base_sequence = baseSequence;

        return this.request<DeleteResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'DELETE',
            body,
            headers: mutationBaseHeaders({ ...options, base_sequence: baseSequence }),
        });
    }

    async deleteMany(ids: string[]): Promise<DeleteManyResponse> {
        // 200 (all ok), 207 (partial), 500 (all failed) all carry a results body — surface directly.
        return this.request<DeleteManyResponse>('/contexts/delete-many', {
            method: 'POST',
            body: { ids },
            acceptStatuses: [200, 207, 500],
        });
    }

    async prunePlaintextVersions(contextId: string): Promise<{ pruned: number }> {
        return this.request<{ pruned: number }>(
            `/contexts/${encodeURIComponent(contextId)}/prune-plaintext-versions`,
            { method: 'POST', body: {} },
        );
    }

    private usesSessionSync(): boolean {
        return Boolean(this.accessToken || this.getAccessTokenFn);
    }

    private captureSyncBaseFromRead(res: { sync_base_sequence?: number }) {
        if (typeof res?.sync_base_sequence === 'number' && Number.isFinite(res.sync_base_sequence)) {
            this.lastSyncBaseSequence = res.sync_base_sequence;
        }
    }

    private async resolveBearerToken(): Promise<string> {
        if (this.getAccessTokenFn) return this.getAccessTokenFn();
        if (this.accessToken) return this.accessToken;
        if (this.apiKey) return this.apiKey;
        throw new Error('Missing InfiniteContext credentials');
    }

    private async request<T>(path: string, init: { method: string; body?: unknown; headers?: Record<string, string>; acceptStatuses?: number[] }): Promise<T> {
        const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
        const bearer = await this.resolveBearerToken();

        const headers: Record<string, string> = {
            Authorization: `Bearer ${bearer}`,
            ...(this.headers ?? {}),
            ...(init.headers ?? {}),
        };

        let body: BodyInit | undefined;
        if (init.body !== undefined) {
            headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
            body = JSON.stringify(init.body);
        }

        const ac = this.timeoutMs ? new AbortController() : undefined;
        const timeout = this.timeoutMs ? setTimeout(() => ac?.abort(), this.timeoutMs) : undefined;

        try {
            const res = await this.fetchFn(url, {
                method: init.method,
                headers,
                body,
                signal: ac?.signal,
            });

            const accepted = init.acceptStatuses?.includes(res.status) ?? false;
            if (!res.ok && !accepted) {
                const bodyText = await safeReadText(res);
                throw new InfiniteContextHttpError({ status: res.status, url, bodyText });
            }

            if (res.status === 204) return undefined as unknown as T;

            const contentType = res.headers.get('content-type') ?? '';
            if (contentType.includes('application/json')) return (await res.json()) as T;
            return (await res.text()) as unknown as T;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }
}

async function safeReadText(res: Response) {
    try {
        return await res.text();
    } catch {
        return undefined;
    }
}
