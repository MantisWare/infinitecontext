import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { StorageError } from "../../lib/storage/errors.mjs";
import {
  assertSftpHostKeyTrusted,
  createSftpHostKeyVerifier,
  hostKeyMatchesFingerprint,
  sha256HostKeyFingerprint,
  unknownHostKeyRefusalMessage,
} from "../../lib/storage/sftp-host-key.mjs";

describe("sftp-host-key", () => {
  it("computes OpenSSH SHA256 fingerprint", () => {
    const raw = crypto.randomBytes(32);
    const fp = sha256HostKeyFingerprint(raw);
    assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
    assert.ok(hostKeyMatchesFingerprint(fp, raw));
  });

  it("matches plain known_hosts entry", () => {
    const raw = crypto.randomBytes(48);
    const b64 = raw.toString("base64");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-kh-"));
    const file = path.join(dir, "known_hosts");
    fs.writeFileSync(file, `[127.0.0.1]:2222 ssh-ed25519 ${b64}\n`, "utf8");
    const verifier = createSftpHostKeyVerifier({
      host: "127.0.0.1",
      port: 2222,
      knownHostsPath: file,
    });
    assert.ok(verifier(raw));
  });

  it("refuses unknown host with fingerprint hint", () => {
    const raw = crypto.randomBytes(32);
    const verifier = createSftpHostKeyVerifier({ host: "example.com", port: 22, knownHostsPath: "/dev/null" });
    assert.throws(
      () => assertSftpHostKeyTrusted(raw, verifier, undefined),
      (err) => err instanceof StorageError && err.message.includes("SHA256:"),
    );
    assert.match(unknownHostKeyRefusalMessage(raw), /config set storage\.sftp\.hostKeySha256/);
  });

  it("hard-fails fingerprint mismatch when pinned", () => {
    const raw = crypto.randomBytes(32);
    const verifier = createSftpHostKeyVerifier({
      host: "127.0.0.1",
      port: 22,
      hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    assert.throws(
      () => assertSftpHostKeyTrusted(raw, verifier, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      (err) => err instanceof StorageError && /mismatch/.test(err.message),
    );
  });
});
