const lockChains = new Map<string, Promise<void>>();

/** Process-wide mutex per root context (used by MemoryStorage in tests). */
export async function acquireRootContextLock(projectId: number, rootPublicId: string): Promise<() => void> {
    const key = `${projectId}:${rootPublicId}`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const prev = lockChains.get(key) ?? Promise.resolve();
    lockChains.set(
        key,
        prev.then(() => held),
    );
    await prev;
    return () => {
        release();
    };
}
