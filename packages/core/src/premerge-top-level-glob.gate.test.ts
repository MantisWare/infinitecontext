import assert from "node:assert/strict";
import { it } from "node:test";

/** Must live at src/*.test.ts (not under src/ops/) so premerge catches broken shell globs. */
it("premerge top-level glob gate: this file must be executed", () => {
  assert.ok(true);
});
