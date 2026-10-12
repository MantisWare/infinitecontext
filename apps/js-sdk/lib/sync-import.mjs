import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, string>} */
const VENDOR_FILES = {
  launcher: "launcher.mjs",
  ctl: "ctl.mjs",
  tui: "tui.mjs",
  sync: "daemon.mjs",
  store: "store.mjs",
  "onboarding-preferences": "onboarding-preferences.mjs",
  "recent-projects": "recent-projects.mjs",
  "ui/hero-art": "ui/hero-art.mjs",
  "ui/constants": "ui/constants.mjs",
};

export function missingSyncPackage(error, subpath) {
  if (!error || typeof error !== "object") return false;
  if (error.code !== "ERR_MODULE_NOT_FOUND") return false;
  const msg = String(error.message ?? "");
  if (msg.includes("@infinitecontext/sync")) return true;
  return msg.includes(`sync/${subpath}`);
}

/**
 * Load @infinitecontext/sync subpaths from workspace (dev) or vendored copy (published tarball).
 * @param {string} subpath
 */
export async function importSync(subpath) {
  const spec = `@infinitecontext/sync/${subpath}`;
  try {
    return await import(spec);
  } catch (error) {
    if (!missingSyncPackage(error, subpath)) throw error;
  }

  const rel = VENDOR_FILES[subpath];
  if (!rel) {
    throw new Error(`Unknown sync module "${subpath}"`);
  }
  const abs = path.join(__dirname, "..", "vendor", "sync", rel);
  return import(pathToFileURL(abs).href);
}
