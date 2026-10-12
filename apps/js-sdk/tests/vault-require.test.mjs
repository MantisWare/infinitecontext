import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatYesNoPromptLabel,
  VAULT_DECLINE_SERVER_READABLE_WARNING,
} from "../lib/vault-require.mjs";

describe("vault-require prompts", () => {
  it("formats yes/no label from the default", () => {
    assert.equal(formatYesNoPromptLabel(true), "[Y/n]");
    assert.equal(formatYesNoPromptLabel(false), "[y/N]");
  });

  it("decline warning mentions vault init and server-readable plaintext", () => {
    assert.match(VAULT_DECLINE_SERVER_READABLE_WARNING, /infinitecontext vault init/);
    assert.match(VAULT_DECLINE_SERVER_READABLE_WARNING, /plaintext/i);
    assert.match(VAULT_DECLINE_SERVER_READABLE_WARNING, /server/i);
  });
});
