import { sampleEncryptedObjectBytesVariant } from "../../lib/storage/contract-suite.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";

const [, , rootDir, mode, workerId, etagArg] = process.argv;

if (!rootDir || !mode || workerId === undefined) {
  console.error("usage: filesystem-race-worker.mjs <rootDir> <create|cas> <workerId> [etag]");
  process.exit(2);
}

const key = "race/multiprocess/object.enc";
const body = sampleEncryptedObjectBytesVariant(key, Number(workerId) + 1);

const adapter = createFilesystemStorageAdapter({ rootDir });
await adapter.init();

try {
  if (mode === "create") {
    await adapter.put(key, body, { ifNoneMatch: "*" });
    console.log("CREATE_WIN");
  } else if (mode === "cas") {
    if (!etagArg) {
      throw new Error("cas mode requires etag");
    }
    await adapter.put(key, body, { ifMatch: etagArg });
    console.log("CAS_WIN");
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "precondition_failed") {
    console.log(mode === "create" ? "CREATE_LOSE" : "CAS_LOSE");
    process.exit(0);
  }
  throw error;
} finally {
  await adapter.close();
}
