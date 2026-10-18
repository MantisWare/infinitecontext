import { setTestStallBeforeLinkMsForTests } from "../../lib/storage/secret-store-file-generations.mjs";

const rootDir = process.argv[2];
const secretName = process.argv[3];
const stallMs = Number(process.argv[4] || 0);
if (!rootDir || !secretName) {
  process.exit(1);
}

setTestStallBeforeLinkMsForTests(stallMs > 0 ? stallMs : 0);

const { SecretStore } = await import("../../lib/storage/secret-store.mjs");

const store = new SecretStore({ mode: "file", rootDir });
const value = new TextEncoder().encode(`value-for-${secretName}`);
try {
  await store.set(secretName, value);
} catch (error) {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "store_retry" || error.code === "lock_compromised") {
      process.exit(2);
    }
  }
  throw error;
}
