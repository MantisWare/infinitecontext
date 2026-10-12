import {
  assertSyncAuth as assertApiKeyAuth,
  createInfiniteContextClient as createApiKeyClient,
} from "./api-key-host-auth.mjs";

/**
 * Auth hooks for daemon/tui when sync runs from source or a standalone tarball.
 */
export async function resolveHostAuthHooks() {
  try {
    const mod = await import("infinitecontext/lib/sync-client-auth.mjs");
    return {
      createInfiniteContextClient: mod.createInfiniteContextClient,
      assertSyncAuth: mod.assertSyncAuth,
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code !== "ERR_MODULE_NOT_FOUND") throw error;
    const msg = String(error.message ?? "");
    if (!msg.includes("infinitecontext")) throw error;
  }

  return {
    createInfiniteContextClient: createApiKeyClient,
    assertSyncAuth: assertApiKeyAuth,
  };
}
