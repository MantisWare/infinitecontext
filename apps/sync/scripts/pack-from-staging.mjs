#!/usr/bin/env node
/**
 * Build a publishable sync tarball from a temp staging tree — never mutates tracked package.json.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const syncRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parsersSrc = path.resolve(syncRoot, "../../packages/parsers/src");
const syncCursorSrc = path.resolve(syncRoot, "../../packages/sync-cursor/src");

/** @param {string} stagingRoot */
export function prepareSyncPublishTree(stagingRoot) {
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.cpSync(path.join(syncRoot, "src"), path.join(stagingRoot, "src"), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}parsers-bundle${path.sep}`),
  });

  const dest = path.join(stagingRoot, "src", "parsers-bundle");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(parsersSrc, dest, { recursive: true });

  const cursorDest = path.join(stagingRoot, "src", "sync-cursor-bundle");
  fs.rmSync(cursorDest, { recursive: true, force: true });
  fs.cpSync(syncCursorSrc, cursorDest, { recursive: true });
  fs.writeFileSync(
    path.join(stagingRoot, "src", "sync-cursor-shim.mjs"),
    'export * from "./sync-cursor-bundle/index.mjs";\n',
  );

  const pkg = JSON.parse(fs.readFileSync(path.join(syncRoot, "package.json"), "utf8"));
  pkg.imports = {
    "#parsers": "./src/parsers-bundle/index.mjs",
    "#parsers/utils": "./src/parsers-bundle/utils.mjs",
    "#sync-cursor": "./src/sync-cursor-bundle/index.mjs",
  };
  if (pkg.dependencies?.["@infinitecontext/parsers"]) {
    delete pkg.dependencies["@infinitecontext/parsers"];
  }
  if (pkg.dependencies?.["@infinitecontext/sync-cursor"]) {
    delete pkg.dependencies["@infinitecontext/sync-cursor"];
  }
  if (pkg.scripts) {
    delete pkg.scripts.prepack;
    delete pkg.scripts.postpack;
  }
  fs.writeFileSync(path.join(stagingRoot, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * @param {{ packDestination?: string, injectFailure?: boolean }} [opts]
 * @returns {string} absolute path to .tgz
 */
export function packSyncFromStaging(opts = {}) {
  const packDestination =
    opts.packDestination ?? fs.mkdtempSync(path.join(os.tmpdir(), "ic-sync-pack-out-"));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sync-pack-staging-"));

  try {
    prepareSyncPublishTree(staging);
    if (opts.injectFailure) {
      throw new Error("injected pack failure (test)");
    }
    const packOutput = execSync(`npm pack --silent --pack-destination ${JSON.stringify(packDestination)}`, {
      cwd: staging,
      encoding: "utf8",
    }).trim();
    const tgzName = packOutput.split("\n").pop();
    return path.join(packDestination, tgzName);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const injectFailure = process.argv.includes("--inject-failure");
  const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), "ic-sync-pack-out-"));
  try {
    const tgz = packSyncFromStaging({ packDestination, injectFailure });
    console.log(tgz);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    if (injectFailure) {
      fs.rmSync(packDestination, { recursive: true, force: true });
    }
  }
}
