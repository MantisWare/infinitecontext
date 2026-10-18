import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findViolations, isForbiddenTestEnvKey } from "./check-lib-no-test-env.mjs";

/** @param {string} src */
function hits(src) {
  return findViolations("fixture.mjs", src);
}

describe("check-lib-no-test-env fixtures", () => {
  it("allows safe literals and rejects false-positive names", () => {
    assert.equal(isForbiddenTestEnvKey("LATEST_VERSION"), false);
    assert.equal(isForbiddenTestEnvKey("IC_TEST_MODE"), true);
    assert.deepEqual(hits("const x = process.env.NODE_ENV;"), []);
    assert.deepEqual(hits("void Object.keys(process.env).length;"), []);
  });

  const mustCatch = [
    ["direct", "void process.env.IC_TEST_MODE;"],
    ["destructure from process.env", "const { IC_TEST_MODE } = process.env;"],
    ["dynamic key variable", 'const k = "IC_TEST_MODE"; void process.env[k];'],
    ["Reflect concat key", 'Reflect.get(process.env, "IC_" + "TEST_MODE");'],
    ["Object.keys scan", "Object.keys(process.env).filter(Boolean);"],
    ["globalThis.process env destructure", "const { env } = globalThis.process; void env.IC_TEST_MODE;"],
    ['process["env"] alias', 'void process["env"].IC_TEST_MODE;'],
    ["template literal key", "void process.env[`IC_TEST_MODE`];"],
    ["globalThis alias chain", "const g = globalThis; void g.process.env.IC_TEST_MODE;"],
    ["require process env", 'const p = require("process"); void p.env.IC_TEST_MODE;'],
    ["dynamic import env", "const p = await import('node:process'); void p.env.IC_TEST_MODE;"],
    ["import env binding", "import { env } from 'node:process'; void env.IC_TEST_MODE;"],
    ["import env as e", "import { env as e } from 'process'; void e.IC_TEST_MODE;"],
    ["import namespace", "import * as p from 'node:process'; void p.env.IC_TEST_MODE;"],
    ["const env from process destructure", "const { env: e2 } = process; void e2.IC_TEST_MODE;"],
    ["Object.entries scan", 'Object.entries(process.env).find(([k]) => k.includes("TEST"));'],
    ["Reflect.get literal", 'Reflect.get(process.env, "IC_TEST_MODE");'],
    ["spread copy env", "void ({...process.env}.IC_TEST_MODE);"],
    ["default param env alias", "function f(env = process.env) { void env.IC_TEST_MODE; } f();"],
  ];

  for (const [label, src] of mustCatch) {
    it(`catches ${label}`, () => {
      const v = hits(src);
      assert.ok(v.length > 0, `expected violation for ${label}, got none`);
    });
  }
});
