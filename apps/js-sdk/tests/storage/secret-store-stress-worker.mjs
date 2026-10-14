import { SecretStore } from "../../lib/storage/secret-store.mjs";

const rootDir = process.argv[2];
const trial = process.argv[3];
const writer = process.argv[4];
if (!rootDir || trial === undefined || writer === undefined) {
  process.exit(1);
}

const store = new SecretStore({ mode: "file", rootDir });
const name = `stress/${trial}/${writer}`;
const value = new TextEncoder().encode(`trial-${trial}-writer-${writer}`);
await store.set(name, value);
