import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveBaseUrlSource } from "../../lib/client-config.mjs";

describe("login base URL source", () => {
  it("labels --base-url as cli flag", () => {
    const src = resolveBaseUrlSource({ cliBaseUrl: "http://127.0.0.1:9999" });
    assert.equal(src.source, "cli flag (--base-url)");
    assert.equal(src.value, "http://127.0.0.1:9999");
  });
});
