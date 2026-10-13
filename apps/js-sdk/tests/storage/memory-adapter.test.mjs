import { describe, it } from "node:test";

import { createMemoryStorageAdapter } from "../../lib/storage/memory-adapter.mjs";
import { runStorageAdapterContractSuite } from "../../lib/storage/contract-suite.mjs";

runStorageAdapterContractSuite(() => createMemoryStorageAdapter(), { describe, it });
