import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isUpdateCheckDisabled } from "../../lib/update-check.mjs";

describe("update check opt-out", () => {
  it("accepts 1, true, and yes", () => {
    assert.equal(isUpdateCheckDisabled("1"), true);
    assert.equal(isUpdateCheckDisabled("true"), true);
    assert.equal(isUpdateCheckDisabled("YES"), true);
    assert.equal(isUpdateCheckDisabled(""), false);
    assert.equal(isUpdateCheckDisabled("0"), false);
  });
});
