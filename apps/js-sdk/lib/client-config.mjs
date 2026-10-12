import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  DOCS_API_BASE_URL_PLACEHOLDER,
  HOSTED_API_BASE_URL,
  KEYS_AND_SERVICES_DOC_URL,
} from "@infinitecontext/core/doc-urls";

export { DOCS_API_BASE_URL_PLACEHOLDER, HOSTED_API_BASE_URL, KEYS_AND_SERVICES_DOC_URL };

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

export function normalizeBaseUrl(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

export function isHostedApiBaseUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl) === HOSTED_API_BASE_URL;
}

/**
 * Resolve API base URL: env → config.json → hosted default.
 * @param {{ env?: NodeJS.ProcessEnv, config?: Record<string, unknown> }} [opts]
 */
export function resolveBaseUrl(opts = {}) {
  const env = opts.env ?? process.env;
  const config = opts.config ?? readConfigFile();
  const fromEnv = String(env.INFINITECONTEXT_BASE_URL ?? "").trim();
  const fromFile = String(config.baseUrl ?? "").trim();
  return normalizeBaseUrl(fromEnv || fromFile || HOSTED_API_BASE_URL);
}

/** Where the effective base URL came from (for config show / login). */
export function resolveBaseUrlSource(opts = {}) {
  if (opts.cliBaseUrl) {
    return {
      source: "cli flag (--base-url)",
      envVar: null,
      value: normalizeBaseUrl(opts.cliBaseUrl),
    };
  }
  const env = opts.env ?? process.env;
  const config = opts.config ?? readConfigFile();
  const fromEnv = String(env.INFINITECONTEXT_BASE_URL ?? "").trim();
  if (fromEnv) {
    return { source: "environment", envVar: "INFINITECONTEXT_BASE_URL", value: normalizeBaseUrl(fromEnv) };
  }
  const fromFile = String(config.baseUrl ?? "").trim();
  if (fromFile) {
    return { source: "config.json", envVar: null, value: normalizeBaseUrl(fromFile) };
  }
  return { source: "default (hosted)", envVar: null, value: HOSTED_API_BASE_URL };
}

export function describeActiveServer(baseUrl = resolveBaseUrl()) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (isHostedApiBaseUrl(normalized)) {
    return {
      baseUrl: normalized,
      kind: "hosted",
      label: "Hosted (free; zero-knowledge when vault is enabled)",
    };
  }
  return { baseUrl: normalized, kind: "self-host", label: "Self-hosted" };
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
  if (keyDef.key === "server") {
    return { source: "default (hosted)", value: HOSTED_API_BASE_URL };
  }
  return { source: "default", value: "" };
}
