import fs from "node:fs";
import { spawn } from "node:child_process";

/**
 * Shared premerge shutdown / TMPDIR hygiene (used by premerge.mjs and regression tests).
 * @param {object} opts
 * @param {string} opts.premergeTmpRoot
 * @param {() => void} [opts.cleanupAll]
 * @param {(signal: import("node:child_process").Signal) => void} [opts.killActiveProcessGroup]
 * @param {(before: Set<string>, after: Set<string>) => void} [opts.assertNoNewIcTmpDirLeaks]
 * @param {() => Set<string>} [opts.listAllIcTmpDirs]
 */
export function createPremergeShutdown(opts) {
  const {
    premergeTmpRoot,
    cleanupAll = () => {},
    killActiveProcessGroup = () => {},
    assertNoNewIcTmpDirLeaks = () => {},
    listAllIcTmpDirs = () => new Set(),
  } = opts;

  /** @type {import("node:child_process").ChildProcess | null} */
  let activeChild = null;
  let shuttingDown = false;
  /** @type {number | null} */
  let shutdownExitCode = null;

  function cleanupNodeCompileCache() {
    const root = premergeTmpRoot;
    if (!root || !fs.existsSync(root)) {
      return;
    }
    const cacheDir = `${root}/node-compile-cache`;
    try {
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
  }

  function cleanupPremergeTmpRoot() {
    cleanupNodeCompileCache();
    const root = premergeTmpRoot;
    if (!root || !fs.existsSync(root)) {
      return;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  function exitPremerge(code) {
    cleanupNodeCompileCache();
    cleanupPremergeTmpRoot();
    process.exit(shutdownExitCode ?? code);
  }

  /**
   * @param {string} message
   * @param {number} [code]
   */
  function fail(message, code = 1) {
    if (shuttingDown) {
      return;
    }
    console.error(message);
    killActiveProcessGroup("SIGKILL");
    cleanupAll();
    exitPremerge(code);
  }

  /**
   * @param {Set<string>} icTmpBeforeTests
   */
  function finalizeTmpHygiene(icTmpBeforeTests) {
    if (shuttingDown) {
      return;
    }
    try {
      assertNoNewIcTmpDirLeaks(icTmpBeforeTests, listAllIcTmpDirs());
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    cleanupPremergeTmpRoot();
  }

  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {Record<string, string | undefined>} [env]
   * @param {string} [cwd]
   * @param {{ allowFailure?: boolean }} [runOpts]
   * @returns {Promise<string>}
   */
  function run(cmd, args, env, cwd, runOpts = {}) {
    const { allowFailure = false } = runOpts;
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["inherit", "pipe", "pipe"],
        detached: true,
      });
      activeChild = child;
      /** @type {string} */
      let out = "";
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        out += text;
        process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        out += text;
        process.stderr.write(chunk);
      });
      child.on("error", (err) => {
        activeChild = null;
        reject(err);
      });
      child.on("close", (status, signal) => {
        activeChild = null;
        if (shuttingDown) {
          reject(new Error("shutting down"));
          return;
        }
        if (signal) {
          reject(new Error(`${cmd} ${args.join(" ")} terminated by ${signal}`));
          return;
        }
        if (status !== 0) {
          if (allowFailure) {
            reject(new Error(`${cmd} ${args.join(" ")} exited ${status ?? 1}`));
            return;
          }
          killActiveProcessGroup("SIGKILL");
          cleanupAll();
          exitPremerge(status ?? 1);
        }
        resolve(out);
      });
    });
  }

  /**
   * @param {number} [maxMs]
   */
  function waitForActiveChildExit(maxMs = 15000) {
    return new Promise((resolve) => {
      const child = activeChild;
      if (!child) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("close", done);
      child.once("error", done);
      const timer = setTimeout(done, maxMs);
      timer.unref?.();
    });
  }

  /**
   * @param {import("node:child_process").Signal} signal
   */
  async function onSignal(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    shutdownExitCode = signal === "SIGINT" ? 130 : 143;
    killActiveProcessGroup("SIGTERM");
    await waitForActiveChildExit();
    killActiveProcessGroup("SIGKILL");
    cleanupAll();
    cleanupNodeCompileCache();
    cleanupPremergeTmpRoot();
    process.exit(shutdownExitCode);
  }

  function registerSignalHandlers() {
    process.on("SIGINT", () => {
      void onSignal("SIGINT");
    });
    process.on("SIGTERM", () => {
      void onSignal("SIGTERM");
    });
  }

  return {
    run,
    fail,
    exitPremerge,
    finalizeTmpHygiene,
    onSignal,
    registerSignalHandlers,
    cleanupPremergeTmpRoot,
    cleanupNodeCompileCache,
    get shuttingDown() {
      return shuttingDown;
    },
    get activeChild() {
      return activeChild;
    },
    get shutdownExitCode() {
      return shutdownExitCode;
    },
  };
}
