import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOSTED_API_BASE_URL } from "./ic-constants.mjs";

function expandHome(filePath) {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function readConfigBaseUrl() {
  const configPath = path.join(os.homedir(), ".infinitecontext", "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(cfg.baseUrl ?? "").trim();
  } catch {
    return "";
  }
}

export function normalizeBaseUrl(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

export function resolveBaseUrl(env = process.env) {
  const fromEnv = String(env.INFINITECONTEXT_BASE_URL ?? "").trim();
  const fromFile = readConfigBaseUrl();
  return normalizeBaseUrl(fromEnv || fromFile || HOSTED_API_BASE_URL);
}
