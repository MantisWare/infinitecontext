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

/**
 * @param {boolean} nodePtyLoadable
 */
function okOutFor(nodePtyLoadable) {
  let out = premergeProbeTestOutput("ok");
  if (!nodePtyLoadable) {
    const floor = infinitecontextMinPassFloor(false);
    out = withPackagePass(out, "infinitecontext", floor);
    out = out.replace(/(> infinitecontext@.+?\n# tests )658/m, `$1${floor + 2}`);
  }
  return out;
}

describe("premerge per-package floors (measured counts)", () => {
  const okOutPty = premergeProbeTestOutput("ok");
  const okOutNoPty = okOutFor(false);

  for (const name of PREMERGE_EXPECTED_PACKAGE_NAMES) {
    it(`dropping one pass in ${name} fails the gate (no node-pty)`, () => {
      const floor = PREMERGE_PACKAGE_MIN_PASS[name];
      let broken;
      if (name === "infinitecontext-python-sdk") {
        broken = okOutNoPty.replace(/(\d+) passed in/, `${floor - 1} passed in`);
      } else {
        broken = withPackagePass(okOutNoPty, name, floor - 1);
      }
      assert.throws(
        () => assertPremergePackageTestSections(broken, { nodePtyLoadable: false }),
        /exact count required|package test coverage failed/,
      );
    });
  }

  it("@infinitecontext/core: one pass above floor fails (no node-pty)", () => {
    const floor = PREMERGE_PACKAGE_MIN_PASS["@infinitecontext/core"];
    const broken = withPackagePass(okOutNoPty, "@infinitecontext/core", floor + 1);
    assert.throws(
      () => assertPremergePackageTestSections(broken, { nodePtyLoadable: false }),
      new RegExp(`pass ${floor + 1} > floor ${floor}`),
    );
  });

  it("infinitecontext with node-pty: floor-1 and floor+1 fail", () => {
    const floor = infinitecontextMinPassFloor(true);
    assert.throws(
      () =>
        assertPremergePackageTestSections(withPackagePass(okOutPty, "infinitecontext", floor - 1), {
          nodePtyLoadable: true,
        }),
      new RegExp(`pass ${floor - 1} < floor ${floor}`),
    );
    assert.throws(
      () =>
        assertPremergePackageTestSections(withPackagePass(okOutPty, "infinitecontext", floor + 1), {
          nodePtyLoadable: true,
        }),
      new RegExp(`pass ${floor + 1} > floor ${floor}`),
    );
  });

  it("infinitecontext with node-pty: probe at floor passes gate", () => {
    assert.doesNotThrow(() =>
      assertPremergePackageTestSections(okOutPty, { nodePtyLoadable: true }),
    );
  });

  it("infinitecontext without node-pty: floor-1 and floor+1 fail", () => {
    const floor = infinitecontextMinPassFloor(false);
    assert.throws(
      () =>
        assertPremergePackageTestSections(withPackagePass(okOutNoPty, "infinitecontext", floor - 1), {
          nodePtyLoadable: false,
        }),
      new RegExp(`pass ${floor - 1} < floor ${floor}`),
    );
    assert.throws(
      () =>
        assertPremergePackageTestSections(withPackagePass(okOutNoPty, "infinitecontext", floor + 1), {
          nodePtyLoadable: false,
        }),
      new RegExp(`pass ${floor + 1} > floor ${floor}`),
    );
  });
});
