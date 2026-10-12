import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(here, "..");

describe("built CLI loads bundled crypto", () => {
  it("dist entry resolves @infinitecontext/crypto without tsx", () => {
    const script = `
      import { isEncryptedContent } from '@infinitecontext/crypto';
      if (!isEncryptedContent({ __ic_enc: 1, kid: 'dek_v1', v: 1, alg: 'XC20P', nonce: 'abc', ct: 'def' })) {
        process.exit(2);
      }
      console.log('ok');
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: sdkRoot,
      env: { ...process.env, NODE_PATH: path.join(sdkRoot, "dist") },
    });
    assert.equal(res.status, 0, res.stderr?.toString() ?? res.stdout?.toString());
  });
});
