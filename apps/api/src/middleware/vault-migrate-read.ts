/** Rate-limit + audit log for X-IC-Vault-Migrate-Read (one-time plaintext/mixed reads). */

type Window = { count: number; windowStartMs: number };

const windows = new Map<number, Window>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;

export function noteVaultMigrateRead(userId: number): { allowed: boolean; logged: boolean } {
    const now = Date.now();
    let row = windows.get(userId);
    if (!row || now - row.windowStartMs >= WINDOW_MS) {
        row = { count: 0, windowStartMs: now };
        windows.set(userId, row);
    }
    row.count += 1;
    const allowed = row.count <= MAX_PER_WINDOW;
    if (row.count === 1 || row.count === MAX_PER_WINDOW || row.count % 20 === 0) {
        console.info(
            JSON.stringify({
                op: 'vault_migrate_read',
                user_id: userId,
                count_in_window: row.count,
                allowed,
            }),
        );
    }
    return { allowed, logged: true };
}
