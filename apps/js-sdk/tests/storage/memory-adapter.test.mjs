import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { runStorageAdapterContractSuite } from "../../lib/storage/contract-suite.mjs";

runStorageAdapterContractSuite(
  async () => {
    const adapter = createMemoryStorageAdapter({ exposeInternalsForTests: true });
    return {
      adapter,
      inspectBacking: () => adapter.exposeInternalsForTests(),
    };
  },
  { describe, it },
);
