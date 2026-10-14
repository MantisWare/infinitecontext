import { sampleEncryptedObjectBytesForKey, sampleEncryptedObjectBytesVariant } from "../../lib/storage/contract-suite.mjs";
import { setFilesystemObjectTestStallBeforeLinkMsForTests } from "../../lib/storage/filesystem-generations.mjs";
import { createFilesystemStorageAdapter } from "../../lib/storage/filesystem-adapter.mjs";

const [, , rootDir, operation, stallMs] = process.argv;

if (!rootDir || !operation || stallMs === undefined) {
  console.error("usage: filesystem-object-stall-worker.mjs <rootDir> <op> <stallMs>");
  process.exit(2);
}

const stall = Number(stallMs);
setFilesystemObjectTestStallBeforeLinkMsForTests(stall > 0 ? stall : 0);

const adapter = createFilesystemStorageAdapter({ rootDir });
await adapter.init();

const key = "stall/object.enc";
const bodyA = sampleEncryptedObjectBytesForKey(key);
const bodyB = sampleEncryptedObjectBytesVariant(key, 0xab);

try {
  if (operation === "create") {
    await adapter.put(key, bodyA, { ifNoneMatch: "*" });
    console.log("STALL_OK create");
  } else if (operation === "update") {
    const head = await adapter.head(key);
    await adapter.put(key, bodyB, { ifMatch: head?.etag });
    console.log("STALL_OK update");
  } else if (operation === "delete") {
    const head = await adapter.head(key);
    await adapter.delete(key, { ifMatch: head?.etag });
    console.log("STALL_OK delete");
  } else {
    throw new Error(`unknown operation ${operation}`);
  }
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "store_retry") {
    console.log("STALL_RETRY");
    process.exit(2);
  }
  throw error;
} finally {
  setFilesystemObjectTestStallBeforeLinkMsForTests(0);
  await adapter.close();
}
