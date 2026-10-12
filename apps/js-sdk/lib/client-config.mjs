import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Placeholder used in docs/OpenAPI — not a runtime default. */
export const DOCS_API_BASE_URL_PLACEHOLDER = "https://your-api.example.com";

/** Mintlify doc for bring-your-own keys and services. */
export const KEYS_AND_SERVICES_DOC_URL =
  "https://docs.infinitecontext.ai/configuration/keys-and-services";

export class MissingClientConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MissingClientConfigError";
  }
}

export function infinitecontextHome() {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), ".infinitecontext");
}

function expandHome(filePath) {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function defaultConfigPath() {
  const fromEnv = String(process.env.INFINITECONTEXT_CONFIG_FILE ?? "").trim();
  if (fromEnv) return expandHome(fromEnv);
  return path.join(infinitecontextHome(), "config.json");
}

export function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(defaultConfigPath(), "utf8"));
  } catch {
    return {};
  }
}

export function writeConfigFile(patch) {
  const file = defaultConfigPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readConfigFile();
  fs.writeFileSync(file, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Resolve API base URL from env then config file. When `required`, throws with doc link.
 * @param {{ env?: NodeJS.ProcessEnv, config?: Record<string, unknown>, required?: boolean }} [opts]
 */
export function resolveBaseUrl(opts = {}) {
  const env = opts.env ?? process.env;
  const config = opts.config ?? readConfigFile();
  const fromEnv = String(env.INFINITECONTEXT_BASE_URL ?? "").trim();
  const fromFile = String(config.baseUrl ?? "").trim();
  const resolved = (fromEnv || fromFile).replace(/\/+$/, "");
  if (!resolved && opts.required !== false) {
    throw new MissingClientConfigError(
      `API base URL is required. Set INFINITECONTEXT_BASE_URL or run: infinitecontext config set server <url>\n` +
        `See ${KEYS_AND_SERVICES_DOC_URL}`,
    );
  }
  return resolved;
}

export function maskSecret(value, { visible = 4 } = {}) {
  const s = String(value ?? "");
  if (!s) return "(not set)";
  if (s.length <= visible * 2) return "*".repeat(s.length);
  return `${s.slice(0, visible)}…${s.slice(-visible)}`;
}

/** Known client-side settings for `config show`. */
export const CLIENT_CONFIG_KEYS = [
  {
    key: "server",
    env: "INFINITECONTEXT_BASE_URL",
    configField: "baseUrl",
    secret: false,
    label: "API base URL",
  },
  {
    key: "apiKey",
    env: "INFINITECONTEXT_API_KEY",
    configField: "apiKey",
    secret: true,
    label: "Legacy API key",
  },
];

export function resolveSettingSource(keyDef) {
  const env = process.env;
  if (String(env[keyDef.env] ?? "").trim()) {
    return { source: "environment", value: String(env[keyDef.env]).trim() };
  }
  const config = readConfigFile();
  if (keyDef.configField && String(config[keyDef.configField] ?? "").trim()) {
    return { source: "config.json", value: String(config[keyDef.configField]).trim() };
  }
  return { source: "default", value: "" };
}
