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

/**
 * Load @infinitecontext/sync subpaths from workspace (dev) or vendored copy (published tarball).
 * @param {string} subpath
 */
export async function importSync(subpath) {
  try {
    return await import(`@infinitecontext/sync/${subpath}`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  const rel = VENDOR_FILES[subpath];
  if (!rel) {
    throw new Error(`Unknown sync module "${subpath}"`);
  }
  const abs = path.join(__dirname, "..", "vendor", "sync", rel);
  return import(pathToFileURL(abs).href);
}
