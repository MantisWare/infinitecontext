import fs from "node:fs";
import { spawn } from "node:child_process";

import {
  collectLegProcessPids,
  removePrivateTmpDirVerified,
  signalPids,
  waitForLegProcessesIdle,
} from "./premerge-process-utils.mjs";

const LEG_TERM_WAIT_MS = 8000;
const LEG_KILL_WAIT_MS = 8000;

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
    removePrivateTmpDirVerified(premergeTmpRoot, () => {
      cleanupNodeCompileCache();
    });
  }

  /**
   * @param {import("node:child_process").Signal} [signal]
   */
  async function terminateActiveLeg(signal = "SIGTERM") {
    const child = activeChild;
    if (!child?.pid) {
      return;
    }
    const rootPid = child.pid;
    const pgid = child.pid;
    try {
      process.kill(-pgid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    }
    const pids = collectLegProcessPids(rootPid, pgid);
    signalPids(pids, signal);
    await waitForLegProcessesIdle(rootPid, pgid, LEG_TERM_WAIT_MS);
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    const killPids = collectLegProcessPids(rootPid, pgid);
    signalPids(killPids, "SIGKILL");
    await waitForLegProcessesIdle(rootPid, pgid, LEG_KILL_WAIT_MS);
    activeChild = null;
  }

  function finishShutdown() {
    cleanupAll();
    cleanupPremergeTmpRoot();
  }

  /**
   * @param {import("node:child_process").Signal} signal
   * @returns {boolean}
   */
  function beginShutdown(signal) {
    if (shuttingDown) {
      return false;
    }
    shuttingDown = true;
    shutdownExitCode = signal === "SIGINT" ? 130 : 143;
    return true;
  }

  function exitPremerge(code) {
    if (shuttingDown) {
      finishShutdown();
      process.exit(shutdownExitCode ?? 130);
    }
    cleanupPremergeTmpRoot();
    process.exit(code);
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
    void terminateActiveLeg("SIGKILL").then(() => {
      cleanupAll();
      exitPremerge(code);
    });
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
          void terminateActiveLeg("SIGKILL").then(() => {
            cleanupAll();
            exitPremerge(status ?? 1);
          });
          return;
        }
        resolve(out);
      });
    });
  }

  async function completeShutdownAfterSignal() {
    await terminateActiveLeg("SIGTERM");
    finishShutdown();
    process.exit(shutdownExitCode ?? 130);
  }

  /**
   * @param {import("node:child_process").Signal} signal
   */
  async function onSignal(signal) {
    if (!beginShutdown(signal)) {
      return;
    }
    await completeShutdownAfterSignal();
  }

  function registerSignalHandlers() {
    process.on("SIGINT", () => {
      if (!beginShutdown("SIGINT")) {
        return;
      }
      void completeShutdownAfterSignal();
    });
    process.on("SIGTERM", () => {
      if (!beginShutdown("SIGTERM")) {
        return;
      }
      void completeShutdownAfterSignal();
    });
  }

  return {
    run,
    fail,
    exitPremerge,
    finalizeTmpHygiene,
    onSignal,
    beginShutdown,
    finishShutdown,
    terminateActiveLeg,
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
