import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(sdkRoot, "../../packages/crypto/dist/index.mjs");
const dest = path.join(sdkRoot, "lib/ic-crypto.mjs");

if (!fs.existsSync(src)) {
  console.error("Missing packages/crypto/dist/index.mjs — run @infinitecontext/crypto build first");
  process.exit(1);
}
fs.copyFileSync(src, dest);
console.log(`Copied crypto bundle to ${dest}`);
