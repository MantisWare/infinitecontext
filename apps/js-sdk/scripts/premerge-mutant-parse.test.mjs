import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePremergeMutants,
  premergeMutantsEnabled,
} from "./premerge-mutant.mjs";
import { buildPremergeLegEnv } from "./premerge-env.mjs";

describe("premerge mutant parsing (deterministic O5)", () => {
  it("parsePremergeMutants is empty without IC_PREMERGE_ALLOW_MUTANT", () => {
    const prevAllow = process.env.IC_PREMERGE_ALLOW_MUTANT;
    const prevMut = process.env.PREMERGE_MUTANT;
    process.env.IC_PREMERGE_ALLOW_MUTANT = "";
    process.env.PREMERGE_MUTANT = "M1,M6";
    try {
      assert.equal(premergeMutantsEnabled(), false);
      assert.equal(parsePremergeMutants().size, 0);
    } finally {
      process.env.IC_PREMERGE_ALLOW_MUTANT = prevAllow;
      process.env.PREMERGE_MUTANT = prevMut;
    }
  });

  it("parsePremergeMutants ignores unknown ids even when allow is set", () => {
    const prevAllow = process.env.IC_PREMERGE_ALLOW_MUTANT;
    const prevMut = process.env.PREMERGE_MUTANT;
    process.env.IC_PREMERGE_ALLOW_MUTANT = "1";
    process.env.PREMERGE_MUTANT = "M6x,M7y,M6";
    try {
      const set = parsePremergeMutants();
      assert.deepEqual([...set], ["M6"]);
    } finally {
      process.env.IC_PREMERGE_ALLOW_MUTANT = prevAllow;
      process.env.PREMERGE_MUTANT = prevMut;
    }
  });

  it("buildPremergeLegEnv never forwards PREMERGE_MUTANT to legs", () => {
    const leg = buildPremergeLegEnv(
      { ...process.env, PREMERGE_MUTANT: "M6", IC_PREMERGE_ALLOW_MUTANT: "1" },
      {
        premergeHome: "/tmp/ic-o5-home",
        premergeTmpRoot: "/tmp/ic-o5-tmp",
        vaultPidRegistryPath: "/tmp/ic-o5-vault.txt",
      },
    );
    assert.equal(leg.PREMERGE_MUTANT, undefined);
    assert.equal(leg.IC_PREMERGE_ALLOW_MUTANT, undefined);
  });
});
