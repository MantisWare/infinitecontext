import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildPremergeLegEnv } from "./premerge-env.mjs";
import { createPremergeShutdown } from "./premerge-shutdown.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dumpScript = path.join(sdkRoot, "scripts/premerge-leg-env-dump.mjs");

describe("premerge leg env stripping", () => {
  it("buildPremergeLegEnv removes mutant and B1 test keys", () => {
    const parent = {
      ...process.env,
      PREMERGE_MUTANT: "M6",
      IC_PREMERGE_ALLOW_MUTANT: "1",
      PREMERGE_TEST_B1_SIGINT_OFFSET_MS: "5",
      PREMERGE_TEST_B1_SIGINT_DELAY_MS: "1",
      PREMERGE_TEST_REVERT_B1: "1",
    };
    const leg = buildPremergeLegEnv(parent, {
      premergeHome: "/tmp/ic-home",
      premergeTmpRoot: "/tmp/ic-tmp",
      vaultPidRegistryPath: "/tmp/ic-vault.txt",
    });
    assert.equal(leg.PREMERGE_MUTANT, undefined);
    assert.equal(leg.IC_PREMERGE_ALLOW_MUTANT, undefined);
    assert.equal(leg.PREMERGE_TEST_B1_SIGINT_OFFSET_MS, undefined);
    assert.equal(leg.PREMERGE_TEST_B1_SIGINT_DELAY_MS, undefined);
    assert.equal(leg.PREMERGE_TEST_REVERT_B1, undefined);
    assert.equal(leg.HOME, "/tmp/ic-home");
  });

  it("shutdown.run child does not inherit stripped keys (leg env dump)", async () => {
    const premergeTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-env-strip-"));
    const outFile = path.join(premergeTmpRoot, "leg-env.json");
    const parentEnv = {
      ...process.env,
      PREMERGE_MUTANT: "M1b",
      IC_PREMERGE_ALLOW_MUTANT: "1",
      PREMERGE_TEST_B1_SIGINT_OFFSET_MS: "99",
    };
    const legEnv = buildPremergeLegEnv(parentEnv, {
      premergeHome: path.join(premergeTmpRoot, "home"),
      premergeTmpRoot,
      vaultPidRegistryPath: path.join(premergeTmpRoot, "vault.txt"),
    });
    fs.mkdirSync(legEnv.HOME, { recursive: true });
    const shutdown = createPremergeShutdown({
      premergeTmpRoot,
      cleanupAll: () => {},
      killActiveProcessGroup: () => {},
      assertNoNewIcTmpDirLeaks: () => {},
      listAllIcTmpDirs: () => new Set(),
    });
    try {
      await shutdown.run(
        process.execPath,
        [dumpScript, outFile],
        { ...legEnv, IC_PREMERGE_LEG_ENV_DUMP: "1" },
        sdkRoot,
      );
      const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
      assert.equal(parsed.PREMERGE_MUTANT, undefined);
      assert.equal(parsed.IC_PREMERGE_ALLOW_MUTANT, undefined);
      assert.equal(parsed.PREMERGE_TEST_B1_SIGINT_OFFSET_MS, undefined);
    } finally {
      fs.rmSync(premergeTmpRoot, { recursive: true, force: true });
    }
  });
});
