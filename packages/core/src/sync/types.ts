export const SYNC_CLIENT_ID_PATTERN = /^icn_[0-9a-f]{24}$/;

export type SyncOp =
    | 'context_create'
    | 'context_fork'
    | 'context_metadata'
    | 'message_append'
    | 'message_update'
    | 'message_delete'
    | 'context_delete'
    | 'contexts_delete_many'
    | 'prune_plaintext_versions';

export type SyncMutation = {
    client_id: string;
    op: SyncOp;
    context_id?: string;
    updated_at?: string;
    payload: Record<string, unknown>;
};

export type SyncChangeRecord = {
    sequence: number;
    op: SyncOp;
    context_id: string | null;
    client_id: string;
    payload: Record<string, unknown>;
    device_id: string | null;
    created_at: string;
};

export type SyncConflictRecord = {
    id: string;
    context_id: string;
    kind: string;
    client_id: string | null;
    sequence: number;
    left_payload: Record<string, unknown>;
    right_payload: Record<string, unknown>;
    created_at: string;
    resolved_at: string | null;
};

export type SyncPushEffect = {
    client_id: string;
    context_id?: string;
    version?: number;
};

export type SyncPushResult = {
    head_sequence: number;
    applied: string[];
    duplicate: string[];
    conflicts: SyncConflictRecord[];
    effects: SyncPushEffect[];
};

export type SyncPullResult = {
    changes: SyncChangeRecord[];
    head_sequence: number;
    next_since: number;
    has_more: boolean;
    conflicts: SyncConflictRecord[];
};
