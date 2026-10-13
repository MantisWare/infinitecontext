/** Thrown when sync_change_log rejects a duplicate (user_id, client_id); aborts the outer DB transaction. */
export class SyncChangeLogClientIdConflict extends Error {
    override name = 'SyncChangeLogClientIdConflict';

    constructor(
        readonly userId: number,
        readonly clientId: string,
    ) {
        super(`Sync change client_id already committed: ${clientId}`);
    }
}
