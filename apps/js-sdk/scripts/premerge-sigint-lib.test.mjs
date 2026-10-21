import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePremergeHomeFromLog,
  parsePremergeNodePidFromLog,
  parsePremergeTmpDirFromLog,
} from "./premerge-sigint-lib.mjs";

describe("premerge sigint lib", () => {
  it("parses node pid and TMPDIR from premerge banner lines", () => {
    const log = `premerge: private TMPDIR=/tmp/ic-premerge-1-abc-tmpdir-x
premerge: isolated HOME=/tmp/ic-premerge-1-abc-tmpdir-x/home-y
premerge: node pid=4242
`;
    assert.equal(parsePremergeNodePidFromLog(log), 4242);
    assert.equal(parsePremergeTmpDirFromLog(log), "/tmp/ic-premerge-1-abc-tmpdir-x");
    assert.equal(parsePremergeHomeFromLog(log), "/tmp/ic-premerge-1-abc-tmpdir-x/home-y");
  });
});
