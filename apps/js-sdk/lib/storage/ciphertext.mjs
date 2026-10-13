import { isEncryptedContent } from "../ic-crypto.mjs";

/**
 * Storage backends must only persist ciphertext bytes (encrypted envelopes or opaque binary).
 * @param {unknown} body
 */
export function assertStorageCiphertext(body) {
  if (!(body instanceof Uint8Array)) {
    throw new TypeError("Storage put body must be Uint8Array ciphertext");
  }
  if (body.length === 0) {
    throw new Error("Storage rejects empty put body");
  }

  const text = tryDecodeUtf8(body);
  if (text === null) {
    return;
  }

  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Storage rejects invalid JSON payload");
    }
    if (Array.isArray(parsed)) {
      throw new Error("Storage rejects plaintext JSON array payloads");
    }
    if (isEncryptedContent(parsed)) {
      return;
    }
    throw new Error("Storage rejects plaintext JSON object payloads");
  }

  throw new Error("Storage rejects likely plaintext UTF-8 payloads");
}

/** @param {Uint8Array} bytes */
function tryDecodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
