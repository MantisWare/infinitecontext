import { SecretStore } from "../../lib/storage/secret-store.mjs";

const rootDir = process.argv[2];
const secretName = process.argv[3];
const stallMs = Number(process.argv[4] || 0);
if (!rootDir || !secretName) {
  process.exit(1);
}

if (stallMs > 0) {
  process.env.IC_SECRET_STORE_TEST_STALL_BEFORE_LINK_MS = String(stallMs);
}

const store = new SecretStore({ mode: "file", rootDir });
const value = new TextEncoder().encode(`value-for-${secretName}`);
try {
  await store.set(secretName, value);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "store_retry") {
    process.exit(2);
  }
  throw error;
}
