import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertPremergePackageTestSections,
  infinitecontextMinPassFloor,
  PREMERGE_EXPECTED_PACKAGE_NAMES,
  PREMERGE_PACKAGE_MIN_PASS,
} from "./premerge-lib.mjs";
import { premergeProbeTestOutput } from "./premerge-probe-output.mjs";

/**
 * @param {string} output
 * @param {string} packageName
 * @param {number} newPass
 */
function withPackagePass(output, packageName, newPass) {
  const headerRe = new RegExp(
    `(^> ${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@.+\\n# tests \\d+\\n# pass )\\d+`,
    "m",
  );
  if (!headerRe.test(output)) {
    throw new Error(`package section not found: ${packageName}`);
  }
  return output.replace(headerRe, `$1${newPass}`);
}

describe("premerge per-package floors (measured counts)", () => {
  const okOut = premergeProbeTestOutput("ok");

  for (const name of PREMERGE_EXPECTED_PACKAGE_NAMES) {
    it(`dropping one pass in ${name} fails the gate (no node-pty)`, () => {
      const floor = PREMERGE_PACKAGE_MIN_PASS[name];
      let broken;
      if (name === "infinitecontext-python-sdk") {
        broken = okOut.replace(/(\d+) passed in/, `${floor - 1} passed in`);
      } else {
        broken = withPackagePass(okOut, name, floor - 1);
      }
      assert.throws(
        () => assertPremergePackageTestSections(broken, { nodePtyLoadable: false }),
        /pass \d+ < floor|package test coverage failed/,
      );
    });
  }

  it("infinitecontext with node-pty: pass 605 fails (floor 606)", () => {
    const floor = infinitecontextMinPassFloor(true);
    assert.equal(floor, 606);
    const broken = withPackagePass(okOut, "infinitecontext", floor - 1);
    assert.throws(
      () => assertPremergePackageTestSections(broken, { nodePtyLoadable: true }),
      /pass 605 < floor 606/,
    );
  });

  it("infinitecontext with node-pty: pass 606 passes gate probe output", () => {
    assert.doesNotThrow(() =>
      assertPremergePackageTestSections(okOut, { nodePtyLoadable: true }),
    );
  });

  it("infinitecontext without node-pty: probe pass 606 still clears floor 593", () => {
    assert.doesNotThrow(() =>
      assertPremergePackageTestSections(okOut, { nodePtyLoadable: false }),
    );
  });
});
