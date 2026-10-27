/**
 * Synthetic pnpm test output for IC_PREMERGE_PROBE gate tests (skip real test leg).
 * @param {string} probe
 */
export function premergeProbeTestOutput(probe) {
  const basePackages = `
> @infinitecontext/auth@0.1.0 test /workspace/packages/auth
# tests 11
# pass 11
# fail 0
# skipped 0
# duration_ms 1
> @infinitecontext/core@0.1.0 test /workspace/packages/core
# tests 179
# pass 179
# fail 0
# skipped 0
# duration_ms 1
> @infinitecontext/crypto@0.1.0 test /workspace/packages/crypto
# tests 23
# pass 23
# fail 0
# skipped 0
# duration_ms 1
> @infinitecontext/parsers@0.1.0 test /workspace/packages/parsers
# tests 117
# pass 115
# fail 0
# skipped 2
# duration_ms 1
> @infinitecontext/storage@0.1.0 test /workspace/packages/storage
# tests 3
# pass 3
# fail 0
# skipped 0
# duration_ms 1
> @infinitecontext/sync@0.1.0 test /workspace/packages/sync
# tests 27
# pass 27
# fail 0
# skipped 0
# duration_ms 1
> @infinitecontext/sync-cursor@0.1.0 test /workspace/packages/sync-cursor
# tests 1
# pass 1
# fail 0
# skipped 0
# duration_ms 1
> infinitecontext-api@ test /workspace/apps/api
# tests 93
# pass 93
# fail 0
# skipped 0
# duration_ms 1
> infinitecontext-mcp-server@ test /workspace/apps/mcp-server
# tests 2
# pass 2
# fail 0
# skipped 0
# duration_ms 1
> infinitecontext-python-sdk@ test /workspace/apps/python-sdk
6 passed in 0.01s
`;
  if (probe === "missing-package") {
    return basePackages;
  }
  if (probe === "zero-tests") {
    return `${basePackages}
> infinitecontext@1.5.0 test /workspace/apps/js-sdk
# duration_ms 1
`;
  }
  if (probe === "floor-violation") {
    return `${basePackages}
> infinitecontext@1.5.0 test /workspace/apps/js-sdk
# tests 595
# pass 100
# fail 0
# skipped 2
# duration_ms 1
`;
  }
  return `${basePackages}
> infinitecontext@1.5.0 test /workspace/apps/js-sdk
# tests 658
# pass 656
# fail 0
# skipped 2
# duration_ms 1
`;
}
