import { sha256 } from "@noble/hashes/sha256";
import { argon2id } from "hash-wasm";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hmac } from "@noble/hashes/hmac";

//#region src/constants.ts
/** Vault passphrase → KEK (client-only; separate from server login password hashing). */
const VAULT_KDF_PARAMS = {
	algorithm: "argon2id",
	memorySizeKiB: 65536,
	iterations: 3,
	parallelism: 4,
	hashLength: 32,
	saltLength: 16
};
const RECOVERY_KEY_BYTES = 32;
const DEK_BYTES = 32;
const ENVELOPE_VERSION = 1;
const AEAD_ALG = "XC20P";
const WRAP_ALG = "XC20P";
/** Metadata keys kept in cleartext for server-side list filters (plan §3.2). */
const CLEARTEXT_METADATA_KEYS = [
	"source",
	"user_id",
	"host",
	"project_path",
	"session_id",
	"ic_root_aad"
];
/** AAD field for encrypting context root metadata (not message bodies). */
const ROOT_METADATA_AAD_FIELD = "context_root";

//#endregion
//#region src/encoding.ts
/** Crockford-like base32 without I/L/O/U for recovery key display. */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_CHECKSUM_BYTES = 2;
function bytesToBase64(bytes) {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}
function base64ToBytes(b64) {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}
function encodeBase32(data) {
	let bits = 0;
	let value = 0;
	const chars = [];
	for (const byte of data) {
		value = value << 8 | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			const index = value >> bits & 31;
			chars.push(RECOVERY_ALPHABET[index]);
		}
	}
	if (bits > 0) chars.push(RECOVERY_ALPHABET[value << 5 - bits & 31]);
	const grouped = [];
	for (let i = 0; i < chars.length; i += 4) grouped.push(chars.slice(i, i + 4).join(""));
	return grouped.join("-");
}
function encodeRecoveryKey(raw) {
	if (raw.length !== 32) throw new Error("Recovery key must be 32 bytes");
	const checksum = sha256(raw).slice(0, RECOVERY_CHECKSUM_BYTES);
	const payload = new Uint8Array(raw.length + RECOVERY_CHECKSUM_BYTES);
	payload.set(raw, 0);
	payload.set(checksum, raw.length);
	return encodeBase32(payload);
}
function decodeRecoveryKey(input) {
	const cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
	let bits = 0;
	let value = 0;
	const out = [];
	for (const ch of cleaned) {
		const idx = RECOVERY_ALPHABET.indexOf(ch);
		if (idx < 0) throw new Error("Invalid recovery key character");
		value = value << 5 | idx;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out.push(value >> bits & 255);
		}
	}
	if (out.length === 32) return new Uint8Array(out);
	const payloadLen = 32 + RECOVERY_CHECKSUM_BYTES;
	if (out.length !== payloadLen) throw new Error("Invalid recovery key length");
	const payload = new Uint8Array(out);
	const raw = payload.slice(0, 32);
	if (!constantTimeEqual(payload.slice(32), sha256(raw).slice(0, RECOVERY_CHECKSUM_BYTES))) throw new Error("Invalid recovery key checksum");
	return raw;
}
function randomBytes(length) {
	return crypto.getRandomValues(new Uint8Array(length));
}
function constantTimeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
	return diff === 0;
}
function bytesToBase64Url(bytes) {
	return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

//#endregion
//#region src/kdf.ts
function serializeKdfParams() {
	return {
		algorithm: VAULT_KDF_PARAMS.algorithm,
		memorySizeKiB: VAULT_KDF_PARAMS.memorySizeKiB,
		iterations: VAULT_KDF_PARAMS.iterations,
		parallelism: VAULT_KDF_PARAMS.parallelism,
		hashLength: VAULT_KDF_PARAMS.hashLength
	};
}
async function deriveVaultKek(passphrase, salt) {
	const hash = await argon2id({
		password: passphrase,
		salt,
		parallelism: VAULT_KDF_PARAMS.parallelism,
		iterations: VAULT_KDF_PARAMS.iterations,
		memorySize: VAULT_KDF_PARAMS.memorySizeKiB,
		hashLength: VAULT_KDF_PARAMS.hashLength,
		outputType: "binary"
	});
	return hash instanceof Uint8Array ? hash : new Uint8Array(hash);
}
/** Recovery key material is used directly as a 256-bit KEK (high entropy). */
function recoveryKeyToKek(recoveryKeyBytes) {
	if (recoveryKeyBytes.length !== 32) throw new Error("Recovery key must be 32 bytes");
	return new Uint8Array(recoveryKeyBytes);
}

//#endregion
//#region src/aead.ts
function encryptAead(key, plaintext, aad) {
	const nonce = randomBytes(24);
	const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
	return {
		v: 1,
		alg: AEAD_ALG,
		nonce: bytesToBase64(nonce),
		ct: bytesToBase64(ct)
	};
}
var DecryptionFailedError = class extends Error {
	constructor(message = "Decryption failed — wrong key, tampered data, or corrupted ciphertext.") {
		super(message);
		this.name = "DecryptionFailedError";
	}
};
function decryptAead(key, envelope, aad) {
	if (envelope.v !== 1 || envelope.alg !== AEAD_ALG) throw new DecryptionFailedError("Unsupported AEAD envelope");
	const nonce = base64ToBytes(envelope.nonce);
	const ct = base64ToBytes(envelope.ct);
	const cipher = xchacha20poly1305(key, nonce, aad);
	try {
		return cipher.decrypt(ct);
	} catch {
		throw new DecryptionFailedError();
	}
}

//#endregion
//#region src/dek-wrap.ts
const WRAP_AAD = new TextEncoder().encode("infinitecontext/dek-wrap/v1");
function wrapDek(dek, kek) {
	const record = {
		v: 1,
		alg: WRAP_ALG,
		envelope: encryptAead(kek, dek, WRAP_AAD)
	};
	return new TextEncoder().encode(JSON.stringify(record));
}
function parseWrappedDekRecord(wrapped) {
	let parsed;
	try {
		parsed = JSON.parse(new TextDecoder().decode(wrapped));
	} catch {
		throw new Error("Invalid wrapped DEK format");
	}
	if (parsed.v !== 1 || parsed.alg !== WRAP_ALG) throw new Error("Unsupported wrapped DEK version");
	if (!parsed.envelope || parsed.envelope.v !== 1) throw new Error("Invalid wrapped DEK envelope");
	return parsed;
}
function unwrapDek(wrapped, kek) {
	return decryptAead(kek, parseWrappedDekRecord(wrapped).envelope, WRAP_AAD);
}
function wrappedDekToBuffer(wrapped) {
	return Buffer.from(wrapped);
}
function bufferToWrappedDek(buf) {
	if (!buf?.length) return null;
	return new Uint8Array(buf);
}

//#endregion
//#region src/envelope-schema.ts
const NONCE_BYTES = 24;
const ALLOWED_ENVELOPE_KEYS = new Set([
	"__ic_enc",
	"kid",
	"v",
	"alg",
	"nonce",
	"ct"
]);
function assertStrictEncryptedEnvelope(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an encrypted envelope object`);
	const rec = value;
	for (const key of Object.keys(rec)) if (!ALLOWED_ENVELOPE_KEYS.has(key)) throw new Error(`${label} contains forbidden plaintext field: ${key}`);
	if (rec[ENCRYPTED_CONTENT_MARKER] !== 1) throw new Error(`${label} missing encryption marker`);
	if (typeof rec.kid !== "string" || !/^dek_v\d+$/.test(rec.kid)) throw new Error(`${label} has invalid kid`);
	if (rec.v !== 1 || rec.alg !== AEAD_ALG) throw new Error(`${label} has unsupported envelope version`);
	if (typeof rec.nonce !== "string" || typeof rec.ct !== "string") throw new Error(`${label} has invalid nonce or ciphertext`);
	let nonceBytes;
	try {
		nonceBytes = base64ToBytes(rec.nonce);
	} catch {
		throw new Error(`${label} has invalid nonce encoding`);
	}
	if (nonceBytes.length !== NONCE_BYTES) throw new Error(`${label} nonce must be ${NONCE_BYTES} bytes`);
}
function validateEncryptedWriteShape(content, metadata) {
	if (!isEncryptedContent(content)) throw new Error("content must be encrypted");
	assertStrictEncryptedEnvelope(content, "content");
	const sensitive = metadata.ic_sensitive;
	if (sensitive !== void 0) {
		if (!sensitive || typeof sensitive !== "object" || Array.isArray(sensitive)) throw new Error("ic_sensitive must be an encrypted envelope");
		assertStrictEncryptedEnvelope(sensitive, "metadata.ic_sensitive");
	}
}

//#endregion
//#region src/node-payload.ts
const ENCRYPTED_CONTENT_MARKER = "__ic_enc";
function buildNodeAad(parts) {
	const nodeIndex = parts.nodeIndex === void 0 ? "" : String(parts.nodeIndex);
	const canonical = [
		"v3",
		parts.userPublicId,
		parts.contextId,
		String(parts.dekVersion),
		parts.field,
		nodeIndex
	].join("|");
	return new TextEncoder().encode(canonical);
}
function buildRootMetadataContextAad(userPublicId, rootAadNonce) {
	return `${userPublicId}|${rootAadNonce}`;
}
function isEncryptedField(value) {
	if (!value || typeof value !== "object") return false;
	const rec = value;
	return rec[ENCRYPTED_CONTENT_MARKER] === ENVELOPE_VERSION && typeof rec.kid === "string";
}
function encryptNodeContent(dek, dekVersion, plaintext, aadParts, options) {
	if (options?.requireNodeBinding !== false && aadParts.nodeIndex === void 0) throw new Error("nodeIndex is required for message content encryption");
	const envelope = encryptAead(dek, new TextEncoder().encode(JSON.stringify(plaintext)), buildNodeAad({
		...aadParts,
		field: "content",
		dekVersion
	}));
	return {
		[ENCRYPTED_CONTENT_MARKER]: ENVELOPE_VERSION,
		kid: `dek_v${dekVersion}`,
		...envelope
	};
}
function decryptNodeContent(dek, wrapped, aadParts, options) {
	if (!isEncryptedField(wrapped)) {
		if (options?.allowPlaintext) return wrapped;
		throw new DecryptionFailedError("Expected encrypted message content");
	}
	assertStrictEncryptedEnvelope(wrapped, "content");
	const dekVersion = parseDekVersion(String(wrapped.kid ?? ""));
	const pt = decryptAead(dek, wrapped, buildNodeAad({
		...aadParts,
		field: "content",
		dekVersion
	}));
	return JSON.parse(new TextDecoder().decode(pt));
}
function splitMetadata(metadata) {
	const cleartext = {};
	const sensitive = {};
	for (const [key, value] of Object.entries(metadata)) if (CLEARTEXT_METADATA_KEYS.includes(key)) cleartext[key] = value;
	else if (key === ENCRYPTED_CONTENT_MARKER || key === "kid" || key === "v" || key === "alg" || key === "nonce" || key === "ct") {} else sensitive[key] = value;
	return {
		cleartext,
		sensitive
	};
}
function encryptNodeMetadata(dek, dekVersion, metadata, aadParts, options) {
	const { cleartext, sensitive } = splitMetadata(metadata);
	if (Object.keys(sensitive).length === 0) return cleartext;
	const field = options?.rootMetadata ? ROOT_METADATA_AAD_FIELD : "metadata_sensitive";
	const rootNonce = typeof cleartext.ic_root_aad === "string" ? cleartext.ic_root_aad : void 0;
	const contextId = field === ROOT_METADATA_AAD_FIELD && rootNonce ? buildRootMetadataContextAad(aadParts.userPublicId, rootNonce) : aadParts.contextId;
	const envelope = encryptAead(dek, new TextEncoder().encode(JSON.stringify(sensitive)), buildNodeAad({
		...aadParts,
		contextId,
		field,
		dekVersion,
		nodeIndex: field === ROOT_METADATA_AAD_FIELD ? void 0 : aadParts.nodeIndex
	}));
	return {
		...cleartext,
		ic_sensitive: {
			[ENCRYPTED_CONTENT_MARKER]: ENVELOPE_VERSION,
			kid: `dek_v${dekVersion}`,
			...envelope
		}
	};
}
function decryptNodeMetadata(dek, metadata, aadParts, options) {
	const sensitiveWrap = metadata.ic_sensitive;
	if (!sensitiveWrap || typeof sensitiveWrap !== "object") {
		if (options?.allowPlaintext) return metadata;
		if (metadataHasAnySensitivePlaintext(metadata)) throw new DecryptionFailedError("Expected encrypted sensitive metadata");
		return metadata;
	}
	const wrap = sensitiveWrap;
	if (!isEncryptedField(wrap)) {
		if (options?.allowPlaintext) return metadata;
		throw new DecryptionFailedError("Expected encrypted sensitive metadata");
	}
	assertStrictEncryptedEnvelope(wrap, "metadata.ic_sensitive");
	const rootNonce = options?.rootMetadata && typeof metadata.ic_root_aad === "string" ? metadata.ic_root_aad : void 0;
	const field = rootNonce ? ROOT_METADATA_AAD_FIELD : "metadata_sensitive";
	const contextId = field === ROOT_METADATA_AAD_FIELD && rootNonce ? buildRootMetadataContextAad(aadParts.userPublicId, rootNonce) : aadParts.contextId;
	const dekVersion = parseDekVersion(String(wrap.kid ?? ""));
	const pt = decryptAead(dek, wrap, buildNodeAad({
		...aadParts,
		contextId,
		field,
		dekVersion,
		nodeIndex: field === ROOT_METADATA_AAD_FIELD ? void 0 : aadParts.nodeIndex
	}));
	const sensitive = JSON.parse(new TextDecoder().decode(pt));
	const { ic_sensitive: _removed, ...cleartext } = metadata;
	return {
		...cleartext,
		...sensitive
	};
}
function metadataHasAnySensitivePlaintext(metadata) {
	for (const [key, value] of Object.entries(metadata)) {
		if (CLEARTEXT_METADATA_KEYS.includes(key)) continue;
		if (key === "ic_sensitive") continue;
		if (value !== void 0 && value !== null) return true;
	}
	return false;
}
function isEncryptedContent(content) {
	return isEncryptedField(content);
}
function parseDekVersion(kid) {
	const match = /^dek_v(\d+)$/.exec(kid);
	if (!match) throw new DecryptionFailedError(`Unknown encryption key id: ${kid}`);
	return Number.parseInt(match[1], 10);
}
function pickCleartextMetadata(metadata) {
	const out = {};
	for (const key of CLEARTEXT_METADATA_KEYS) if (metadata[key] !== void 0) out[key] = metadata[key];
	return out;
}

//#endregion
//#region src/passphrase-policy.ts
var PassphrasePolicyError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "PassphrasePolicyError";
	}
};
function assertVaultPassphrase(passphrase) {
	const trimmed = passphrase.trim();
	if (trimmed.length === 0) throw new PassphrasePolicyError("Vault passphrase cannot be empty.");
	if (trimmed.length < 12) throw new PassphrasePolicyError("Vault passphrase must be at least 12 characters.");
	const hasLetter = /[A-Za-z]/.test(trimmed);
	const hasDigit = /\d/.test(trimmed);
	if (!hasLetter || !hasDigit) throw new PassphrasePolicyError("Vault passphrase must include letters and numbers.");
}

//#endregion
//#region src/vault-setup.ts
async function createVaultCryptoMaterial(passphrase) {
	assertVaultPassphrase(passphrase);
	const dek = randomBytes(DEK_BYTES);
	const recoveryKeyBytes = randomBytes(RECOVERY_KEY_BYTES);
	const kdfSalt = randomBytes(16);
	const kekPass = await deriveVaultKek(passphrase, kdfSalt);
	const kekRecovery = recoveryKeyToKek(recoveryKeyBytes);
	return {
		dek,
		recoveryKeyBytes,
		recoveryKeyDisplay: encodeRecoveryKey(recoveryKeyBytes),
		kdfSalt,
		kdfParams: serializeKdfParams(),
		wrappedDekPassphrase: wrapDek(dek, kekPass),
		wrappedDekRecovery: wrapDek(dek, kekRecovery),
		dekVersion: 1
	};
}
async function rewrapDekWithNewPassphrase(input) {
	const kdfSalt = input.kdfSalt ?? randomBytes(16);
	const kek = await deriveVaultKek(input.newPassphrase, kdfSalt);
	return {
		wrappedDek: wrapDek(input.dek, kek),
		kdfSalt
	};
}
async function rotateRecoveryWrap(input) {
	const kek = recoveryKeyToKek(input.newRecoveryKeyBytes);
	return {
		recoveryKeyDisplay: encodeRecoveryKey(input.newRecoveryKeyBytes),
		wrappedDekRecovery: wrapDek(input.dek, kek)
	};
}

//#endregion
//#region src/plaintext-policy.ts
const SENSITIVE_METADATA_WRAP_KEY = "ic_sensitive";
function metadataHasSensitivePlaintext(metadata) {
	for (const [key, value] of Object.entries(metadata)) {
		if (CLEARTEXT_METADATA_KEYS.includes(key)) continue;
		if (key === SENSITIVE_METADATA_WRAP_KEY) {
			if (value && typeof value === "object" && isEncryptedContent(value)) try {
				assertStrictEncryptedEnvelope(value, "metadata.ic_sensitive");
				continue;
			} catch {
				return true;
			}
			return true;
		}
		if (value !== void 0 && value !== null) return true;
	}
	return false;
}
function stripWriteSelectors(content) {
	const { id: _id, index: _index, ...rest } = content;
	return rest;
}
function isEncryptedWritePayload(content, metadata) {
	try {
		validateEncryptedWriteShape(stripWriteSelectors(content), metadata);
		return true;
	} catch {
		return false;
	}
}
function extractMessageWrites(body) {
	const items = [];
	let topLevelMetadata;
	const pushOne = (raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
		const rec = raw;
		if (Array.isArray(rec.updates)) {
			if (rec.metadata !== void 0) topLevelMetadata = rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata) ? rec.metadata : {};
			for (const update of rec.updates) pushOne(update);
			return;
		}
		const { metadata, id: _id, index: _index, ...content } = rec;
		items.push({
			content,
			metadata: metadata && typeof metadata === "object" ? metadata : {}
		});
	};
	if (Array.isArray(body)) for (const item of body) pushOne(item);
	else pushOne(body);
	if (topLevelMetadata && metadataHasSensitivePlaintext(topLevelMetadata)) items.push({
		content: {},
		metadata: topLevelMetadata
	});
	return items;
}
function contextRootMetadata(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return {};
	const metadata = body.metadata;
	return metadata && typeof metadata === "object" ? metadata : {};
}
function deleteBodyMetadata(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return void 0;
	const metadata = body.metadata;
	return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : void 0;
}

//#endregion
//#region src/dek-proof.ts
const DEK_PROOF_LABEL = new TextEncoder().encode("infinitecontext/dek-proof/v1");
function computeDekProof(dek) {
	return hmac(sha256, dek, DEK_PROOF_LABEL);
}
function dekProofToBase64(dek) {
	return bytesToBase64(computeDekProof(dek));
}
function verifyDekProof(dek, proofBase64) {
	try {
		return constantTimeEqual(computeDekProof(dek), base64ToBytes(proofBase64));
	} catch {
		return false;
	}
}
function verifyDekProofBytes(dek, proofTag) {
	return constantTimeEqual(computeDekProof(dek), proofTag);
}

//#endregion
export { AEAD_ALG, CLEARTEXT_METADATA_KEYS, DEK_BYTES, DecryptionFailedError, ENCRYPTED_CONTENT_MARKER, ENVELOPE_VERSION, PassphrasePolicyError, RECOVERY_KEY_BYTES, ROOT_METADATA_AAD_FIELD, VAULT_KDF_PARAMS, WRAP_ALG, assertStrictEncryptedEnvelope, assertVaultPassphrase, base64ToBytes, bufferToWrappedDek, buildNodeAad, buildRootMetadataContextAad, bytesToBase64, bytesToBase64Url, computeDekProof, constantTimeEqual, contextRootMetadata, createVaultCryptoMaterial, decodeRecoveryKey, decryptAead, decryptNodeContent, decryptNodeMetadata, dekProofToBase64, deleteBodyMetadata, deriveVaultKek, encodeRecoveryKey, encryptAead, encryptNodeContent, encryptNodeMetadata, extractMessageWrites, isEncryptedContent, isEncryptedWritePayload, metadataHasSensitivePlaintext, parseDekVersion, parseWrappedDekRecord, pickCleartextMetadata, randomBytes, recoveryKeyToKek, rewrapDekWithNewPassphrase, rotateRecoveryWrap, serializeKdfParams, splitMetadata, unwrapDek, validateEncryptedWriteShape, verifyDekProof, verifyDekProofBytes, wrapDek, wrappedDekToBuffer };