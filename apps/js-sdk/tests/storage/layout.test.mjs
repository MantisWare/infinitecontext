import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import {
  DecryptionFailedError,
  deriveVaultKek,
  randomBytes,
  unwrapDek,
} from "../../lib/ic-crypto.mjs";
import { encryptLogSegmentWithFixedNonceForTests } from "../helpers/layout-test-crypto.mjs";
import {
  IC_LAYOUT_LOG_AAD_VERSION,
  LayoutIntegrityError,
  LayoutPaddingError,
  buildLayoutLogSegmentAad,
  buildVaultJsonWithWrappedDek,
  decodeVaultJson,
  deriveDevH,
  deriveNamingKey,
  deviceEncRelativePath,
  decryptLogSegment,
  encryptLogSegment,
  encodeCrockfordBase32,
  parseStrictWrappedDekBytes,
  layoutRootPath,
  layoutSegmentEnvelopeDigest,
  lockRelativePath,
  logSegmentRelativePath,
  manifestEncRelativePath,
  padSegmentPlaintext,
  unpadSegmentPlaintext,
  snapEncRelativePath,
  vaultJsonRelativePath,
  verifyLogSegmentChain,
} from "../../lib/storage/layout.mjs";

const TEST_DEK = new Uint8Array([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
]);
const TEST_DEVICE = "550e8400-e29b-41d4-a716-446655440000";
const TEST_NONCE = new Uint8Array(24).fill(0xab);
const TEST_PREFIX = "accounts/usr_demo";

const VECTOR_NAMING_KEY_HEX = "a280a0233bce1600494177d766bf6c5570dd11c8bd944250f4f0d9a6fa50e6e3";
const VECTOR_DEVH = "B5BJ1FNKYNTHNG5K5H13JMHZ5W";
const VECTOR_NONCE_B64 = "q6urq6urq6urq6urq6urq6urq6urq6ur";
const VECTOR_CT_B64 =
  "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";

describe("storage layout naming + paths", () => {
  it("exposes deterministic naming test vectors", () => {
    assert.equal(bytesToHex(deriveNamingKey(TEST_DEK)), VECTOR_NAMING_KEY_HEX);
    assert.equal(deriveDevH(TEST_DEK, TEST_DEVICE), VECTOR_DEVH);
    assert.equal(
      new TextDecoder().decode(buildLayoutLogSegmentAad(VECTOR_DEVH, 7)),
      `ic-storage|${IC_LAYOUT_LOG_AAD_VERSION}|log|${VECTOR_DEVH}|7`,
    );
    const namingKey = deriveNamingKey(TEST_DEK);
    const mac = hmac(sha256, namingKey, new TextEncoder().encode(TEST_DEVICE));
    assert.equal(deriveDevH(TEST_DEK, TEST_DEVICE), encodeCrockfordBase32(mac.slice(0, 16)));
    assert.equal(deriveDevH(TEST_DEK, TEST_DEVICE.toUpperCase()), VECTOR_DEVH);
  });

  it("builds ic-v1 relative paths", () => {
    const root = layoutRootPath(TEST_PREFIX);
    assert.equal(root, "accounts/usr_demo/ic-v1");
    assert.equal(vaultJsonRelativePath(TEST_PREFIX), `${root}/vault.json`);
    assert.equal(manifestEncRelativePath(TEST_PREFIX), `${root}/manifest.json.enc`);
    assert.equal(
      deviceEncRelativePath(TEST_PREFIX, VECTOR_DEVH),
      `${root}/devices/${VECTOR_DEVH}.json.enc`,
    );
    assert.equal(
      logSegmentRelativePath(TEST_PREFIX, VECTOR_DEVH, 3),
      `${root}/log/${VECTOR_DEVH}/000000000003.enc`,
    );
    assert.equal(snapEncRelativePath(TEST_PREFIX, 42), `${root}/snap/00000042.enc`);
    assert.equal(lockRelativePath(TEST_PREFIX, "manifest"), `${root}/lock/manifest.lock`);
  });
});

describe("storage layout log segments", () => {
  it("matches deterministic ciphertext vector and round-trips", () => {
    const devH = VECTOR_DEVH;
    const record = {
      dev: TEST_DEVICE,
      seq: 0,
      prev_digest: "",
      created_at: "2026-10-14T12:00:00.000Z",
      mutations: [{ op: "put", key: "demo" }],
    };
    const envelope = encryptLogSegmentWithFixedNonceForTests(TEST_DEK, devH, record, TEST_NONCE);
    assert.equal(envelope.nonce, VECTOR_NONCE_B64);
    assert.equal(envelope.ct, VECTOR_CT_B64);
    const roundTrip = decryptLogSegment(TEST_DEK, devH, 0, envelope);
    assert.deepEqual(roundTrip.mutations, record.mutations);
    assert.equal(roundTrip.dev, TEST_DEVICE);
  });

  it("uses length-prefixed multi-bucket padding", () => {
    const big = "x".repeat(4096);
    const padded = padSegmentPlaintext(JSON.stringify({ note: big }));
    assert.equal(padded.length, 8192);
  });

  it("detects tamper, rename, reorder, and payload binding", () => {
    const devH = deriveDevH(TEST_DEK, TEST_DEVICE);
    const seg0 = encryptLogSegment(TEST_DEK, devH, {
      dev: TEST_DEVICE,
      seq: 0,
      prev_digest: "",
      created_at: "2026-10-14T12:00:00.000Z",
      mutations: [],
    });
    const d0 = layoutSegmentEnvelopeDigest(seg0);
    const seg1 = encryptLogSegment(TEST_DEK, devH, {
      dev: TEST_DEVICE,
      seq: 1,
      prev_digest: d0,
      created_at: "2026-10-14T12:00:01.000Z",
      mutations: [{ op: "append" }],
    });
    const head = { seq: 1, digest: layoutSegmentEnvelopeDigest(seg1) };

    verifyLogSegmentChain(TEST_DEK, devH, [
      { seq: 0, envelope: seg0 },
      { seq: 1, envelope: seg1 },
    ], head);

    const tampered = { ...seg1, ct: `${seg1.ct.slice(0, -4)}AAAA` };
    assert.throws(
      () => decryptLogSegment(TEST_DEK, devH, 1, tampered),
      DecryptionFailedError,
    );

    assert.throws(() => decryptLogSegment(TEST_DEK, devH, 0, seg1), DecryptionFailedError);

    const wrongDevH = "11111111111111111111111111";
    assert.throws(
      () => decryptLogSegment(TEST_DEK, wrongDevH, 1, seg1),
      DecryptionFailedError,
    );

    assert.throws(
      () =>
        verifyLogSegmentChain(
          TEST_DEK,
          devH,
          [{ seq: 0, envelope: seg0 }],
          head,
        ),
      LayoutIntegrityError,
    );

    assert.throws(
      () =>
        verifyLogSegmentChain(TEST_DEK, devH, [], head),
      LayoutIntegrityError,
    );

    assert.throws(
      () =>
        verifyLogSegmentChain(
          TEST_DEK,
          devH,
          [
            { seq: 0, envelope: seg0 },
            {
              seq: 1,
              envelope: encryptLogSegment(TEST_DEK, devH, {
                dev: TEST_DEVICE,
                seq: 1,
                prev_digest: "a".repeat(64),
                created_at: "2026-10-14T12:00:01.000Z",
                mutations: [],
              }),
            },
          ],
          head,
        ),
      LayoutIntegrityError,
    );

    assert.throws(
      () =>
        verifyLogSegmentChain(
          TEST_DEK,
          devH,
          [
            { seq: 1, envelope: seg1 },
            { seq: 0, envelope: seg0 },
          ],
          head,
        ),
      LayoutIntegrityError,
    );

    assert.throws(
      () =>
        verifyLogSegmentChain(
          TEST_DEK,
          devH,
          [
            { seq: 0, envelope: seg0 },
            { seq: 1, envelope: seg0 },
          ],
          head,
        ),
      LayoutIntegrityError,
    );
  });

  it("rejects extra segment record fields", () => {
    assert.throws(
      () =>
        encryptLogSegment(TEST_DEK, VECTOR_DEVH, {
          dev: TEST_DEVICE,
          seq: 0,
          prev_digest: "",
          created_at: "2026-10-14T12:00:00.000Z",
          mutations: [],
          extra: true,
        }),
      /forbidden field/,
    );
  });

  it("rejects invalid padding length prefix", () => {
    const padded = padSegmentPlaintext("{}");
    padded[0] = 0xff;
    padded[1] = 0xff;
    padded[2] = 0xff;
    padded[3] = 0xff;
    assert.throws(() => unpadSegmentPlaintext(padded), LayoutPaddingError);
  });
});

describe("vault.json codec", () => {
  it("round-trips wrapped DEK with kdf salt for passphrase unwrap", async () => {
    const dek = randomBytes(32);
    dek[0] = 1;
    const salt = randomBytes(16);
    const passphrase = "test-passphrase-12chars";
    const kek = await deriveVaultKek(passphrase, salt);
    const json = buildVaultJsonWithWrappedDek(dek, kek, salt);
    const parsed = decodeVaultJson(json);
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.kdfSalt, salt);
    const unwrapped = unwrapDek(parsed.wrappedDekBytes, await deriveVaultKek(passphrase, parsed.kdfSalt));
    assert.deepEqual(unwrapped, dek);
  });

  it("rejects weak kdf params and extra fields", async () => {
    const dek = randomBytes(32);
    const salt = randomBytes(16);
    const kek = await deriveVaultKek("test-passphrase-12chars", salt);
    const json = buildVaultJsonWithWrappedDek(dek, kek, salt);
    assert.throws(
      () =>
        decodeVaultJson(
          json.replace('"memorySizeKiB":65536', '"memorySizeKiB":1024'),
        ),
      /memorySizeKiB out of allowed range/,
    );
    assert.throws(
      () => decodeVaultJson('{"ic_vault_v":1,"kdf_salt_b64":"x","kdf":{},"wrapped_dek_b64":"x","extra":1}'),
      /forbidden/,
    );
    const salt2 = randomBytes(16);
    const kek2 = await deriveVaultKek("test-passphrase-12chars", salt2);
    const wrapped = JSON.parse(
      new TextDecoder().decode(
        (await import("../../lib/ic-crypto.mjs")).wrapDek(randomBytes(32), kek2),
      ),
    );
    wrapped.extra = true;
    const wrappedBytes = new TextEncoder().encode(JSON.stringify(wrapped));
    assert.throws(() => parseStrictWrappedDekBytes(wrappedBytes), /forbidden field/);
  });
});
