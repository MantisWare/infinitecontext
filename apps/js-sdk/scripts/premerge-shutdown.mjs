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
 * @param {typeof process.kill} [opts.killProcess]
 */
export function createPremergeShutdown(opts) {
  const {
    premergeTmpRoot,
    cleanupAll = () => {},
    killActiveProcessGroup = () => {},
    assertNoNewIcTmpDirLeaks = () => {},
    listAllIcTmpDirs = () => new Set(),
    killProcess = process.kill.bind(process),
  } = opts;

  /** @type {import("node:child_process").ChildProcess | null} */
  let activeChild = null;
  let shuttingDown = false;
  /** @type {number | null} */
  let shutdownExitCode = null;

  /** Yield so SIGINT during blocking cleanup is observed before exitPremerge(1). */
  async function drainPendingSigint() {
    if (String(process.env.PREMERGE_MUTANT ?? "").includes("M1")) {
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
    const until = Date.now() + 500;
    while (!shuttingDown && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

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
    const ok = removePrivateTmpDirVerified(premergeTmpRoot, () => {
      cleanupNodeCompileCache();
    });
    if (!ok) {
      console.error(
        `ERROR: premerge failed to remove private TMPDIR after retry — leftover path: ${premergeTmpRoot}`,
      );
    }
    return ok;
  }

  /**
   * @param {import("node:child_process").Signal} [signal]
   */
  async function terminateActiveLeg(signal = "SIGTERM") {
    const child = activeChild;
    if (!child?.pid) {
      return;
    }
    const mut = String(process.env.PREMERGE_MUTANT ?? "");
    if (mut.includes("M7")) {
      return;
    }
    const rootPid = child.pid;
    const pgid = child.pid;
    const skipGroupKill = mut.includes("M1b") || mut.includes("M1") || mut.includes("M2");
    const fast = shuttingDown;
    const termSignal = fast ? "SIGKILL" : signal;
    const termWaitMs = fast ? 250 : LEG_TERM_WAIT_MS;
    const killWaitMs = fast ? 250 : LEG_KILL_WAIT_MS;
    if (!skipGroupKill) {
      try {
        killProcess(-pgid, termSignal);
      } catch {
        try {
          killProcess(child.pid, termSignal);
        } catch {
          /* ignore */
        }
      }
    }
    if (mut.includes("M1") || mut.includes("M2")) {
      activeChild = null;
      return;
    }
    const pids = collectLegProcessPids(rootPid, pgid);
    signalPids(pids, termSignal, killProcess);
    await waitForLegProcessesIdle(rootPid, pgid, termWaitMs);
    if (!skipGroupKill) {
      try {
        killProcess(-pgid, "SIGKILL");
      } catch {
        try {
          killProcess(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    const killPids = collectLegProcessPids(rootPid, pgid);
    signalPids(killPids, "SIGKILL", killProcess);
    await waitForLegProcessesIdle(rootPid, pgid, killWaitMs);
    activeChild = null;
  }

  function finishShutdown() {
    cleanupAll();
    if (!cleanupPremergeTmpRoot()) {
      process.exit(1);
    }
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
    if (shuttingDown && !String(process.env.PREMERGE_MUTANT ?? "").includes("M3")) {
      finishShutdown();
      process.exit(shutdownExitCode ?? 130);
    }
    if (!cleanupPremergeTmpRoot()) {
      process.exit(1);
    }
    process.exit(code);
  }

  /**
   * @param {string} message
   * @param {number} [code]
   */
  async function fail(message, code = 1) {
    if (shuttingDown) {
      exitPremerge(shutdownExitCode ?? 130);
    }
    console.error(message);
    await drainPendingSigint();
    if (shuttingDown) {
      exitPremerge(shutdownExitCode ?? 130);
    }
    await terminateActiveLeg("SIGKILL");
    cleanupAll();
    exitPremerge(code);
    throw new Error("premerge fail did not terminate process");
  }

  /**
   * @param {Set<string>} icTmpBeforeTests
   */
  async function finalizeTmpHygiene(icTmpBeforeTests) {
    if (shuttingDown) {
      return;
    }
    try {
      assertNoNewIcTmpDirLeaks(icTmpBeforeTests, listAllIcTmpDirs());
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
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
          if (signal === "SIGINT" || signal === "SIGTERM") {
            beginShutdown(signal);
            reject(new Error("shutting down"));
            return;
          }
          reject(new Error(`${cmd} ${args.join(" ")} terminated by ${signal}`));
          return;
        }
        if (status !== 0) {
          if (allowFailure) {
            if (shuttingDown) {
              reject(new Error("shutting down"));
              return;
            }
            reject(new Error(`${cmd} ${args.join(" ")} exited ${status ?? 1}`));
            return;
          }
          void (async () => {
            await drainPendingSigint();
            if (shuttingDown) {
              reject(new Error("shutting down"));
              return;
            }
            await terminateActiveLeg("SIGKILL");
            if (shuttingDown) {
              reject(new Error("shutting down"));
              return;
            }
            cleanupAll();
            exitPremerge(status ?? 1);
          })();
          return;
        }
        resolve(out);
      });
    });
  }

  async function completeShutdownAfterSignal() {
    await terminateActiveLeg("SIGTERM");
    finishShutdown();
    exitPremerge(shutdownExitCode ?? 130);
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
    const onInt = () => {
      const arm = () => {
        if (!beginShutdown("SIGINT")) {
          return;
        }
        void completeShutdownAfterSignal();
      };
      if (String(process.env.PREMERGE_MUTANT ?? "").includes("M2")) {
        setTimeout(arm, 2000);
        return;
      }
      arm();
    };
    process.on("SIGINT", onInt);
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
    drainPendingSigint,
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
