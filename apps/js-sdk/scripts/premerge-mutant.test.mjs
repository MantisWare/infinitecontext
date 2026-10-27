import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blockingFixture = path.join(sdkRoot, "tests/storage/fixtures/premerge-blocking-cleanup-sigint.mjs");
const lateWriterLeg = path.join(sdkRoot, "tests/storage/fixtures/premerge-late-writer-leg.mjs");
const orphanFdLeg = path.join(sdkRoot, "tests/storage/fixtures/premerge-m1b-orphan-fd-leg.mjs");

/**
 * @param {string} script
 * @param {Record<string, string>} [extraEnv]
 */
/**
 * @param {number} pid
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} script
 * @param {Record<string, string>} [extraEnv]
 * @param {{ intDelayMs?: number }} [opts]
 */
async function sigintExitCode(script, extraEnv = {}, opts = {}) {
  const intDelayMs = opts.intDelayMs ?? 200;
  const child = spawn(process.execPath, [script], {
    cwd: sdkRoot,
    env: { ...process.env, PREMERGE_MUTANT: "", IC_PREMERGE_ALLOW_MUTANT: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    execArgv: [],
  });
  let buf = "";
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const onData = (c) => {
      buf += String(c);
      if (
        buf.includes("BLOCKING_CLEANUP_STARTED") ||
        buf.includes("LATE_WRITER_LEG_READY") ||
        buf.includes("ORPHAN_FD_LEG_READY")
      ) {
        resolve(undefined);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const poll = () => {
      if (
        buf.includes("BLOCKING_CLEANUP_STARTED") ||
        buf.includes("LATE_WRITER_LEG_READY") ||
        buf.includes("ORPHAN_FD_LEG_READY")
      ) {
        resolve(undefined);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("ready timeout"));
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
  await new Promise((r) => setTimeout(r, intDelayMs));
  child.kill("SIGINT");
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  return code;
}

/**
 * Mutant matrix (PREMERGE_MUTANT env only — never in production):
 *
 * | ID  | Effect                         | Outcome |
 * |-----|--------------------------------|---------|
 * | M1  | drainPendingSigint no-op       | KILLED (exit ≠ 130) |
 * | M2  | delayed beginShutdown          | KILLED |
 * | M3  | exitPremerge ignores latch     | KILLED (exit 1) |
 * | M6  | skip killProcessesUsingPath    | KILLED (TMPDIR left) |
 * | M7  | skip terminateActiveLeg        | KILLED (child alive) |
 * | M1b | skip kill(-pgid) only          | STRUCTURAL KILL — see premerge-shutdown-group-kill.test.mjs; integration TMPDIR still clears via per-PID walk + path kill (redundant with M6/M7 caught) |
 *
 * M1b is not a production surviving mutant: group kill is mandatory and tested via kill(-pgid) ordering.
 */
describe("premerge mutants must fail", () => {
  it("M1: single setImmediate yield breaks blocking SIGINT (exit not 130)", async () => {
    const child = spawn(process.execPath, [blockingFixture], {
      cwd: sdkRoot,
      env: { ...process.env, IC_PREMERGE_ALLOW_MUTANT: "1", PREMERGE_MUTANT: "M1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const onData = (c) => {
        buf += String(c);
        if (buf.includes("BLOCKING_CLEANUP_STARTED")) {
          resolve(undefined);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const poll = () => {
        if (buf.includes("BLOCKING_CLEANUP_STARTED")) {
          resolve(undefined);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("ready timeout"));
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 1);
  });

  it("M2: delayed shutdown flag breaks blocking SIGINT (exit not 130)", async () => {
    const code = await sigintExitCode(blockingFixture, { PREMERGE_MUTANT: "M2" });
    assert.notEqual(code, 130);
  });

  it("M3: exitPremerge ignores shuttingDown (latched INT still exits 1)", async () => {
    const probe = path.join(sdkRoot, "tests/storage/fixtures/premerge-mutant-m3-probe.mjs");
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [probe], {
        cwd: sdkRoot,
        env: { ...process.env, IC_PREMERGE_ALLOW_MUTANT: "1", PREMERGE_MUTANT: "M3" },
        stdio: "ignore",
      });
      child.on("exit", (c) => resolve(c));
    });
    assert.equal(code, 1);
  });

  it("M6: skip killProcessesUsingPath leaves TMPDIR after late-writer SIGINT", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mutant-m6-"));
    try {
    const child = spawn(process.execPath, [lateWriterLeg], {
      cwd: sdkRoot,
      env: {
        ...process.env,
        IC_PREMERGE_ALLOW_MUTANT: "1",
        PREMERGE_MUTANT: "M6,M7",
        IC_PREMERGE_TMPDIR: tmpRoot,
        TMPDIR: tmpRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      child.stdout?.on("data", (c) => {
        buf += String(c);
        if (buf.includes("LATE_WRITER_LEG_READY")) resolve(undefined);
      });
      const poll = () => {
        if (buf.includes("LATE_WRITER_LEG_READY")) {
          resolve(undefined);
          return;
        }
        if (Date.now() > deadline) reject(new Error("timeout"));
        else setImmediate(poll);
      };
      poll();
    });
    child.kill("SIGINT");
    await new Promise((resolve) => child.on("exit", resolve));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.existsSync(tmpRoot), true);
    } finally {
      const { killProcessesUsingPath } = await import("./premerge-process-utils.mjs");
      killProcessesUsingPath(tmpRoot, "SIGKILL");
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("M1b only: detached orphan fd under TMPDIR still removed (surviving mutant — no cwd/env probe)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mutant-m1b-orphan-"));
    const orphanPidFile = path.join(os.tmpdir(), `ic-m1b-orphan-pid-${process.pid}-${Date.now()}.pid`);
    /** @type {number | null} */
    let orphanPid = null;
    try {
      const code = await sigintExitCode(orphanFdLeg, {
        PREMERGE_MUTANT: "M1b",
        IC_PREMERGE_TMPDIR: tmpRoot,
        TMPDIR: tmpRoot,
        IC_PREMERGE_ORPHAN_PID_FILE: orphanPidFile,
      });
      assert.equal(code, 130);
      assert.equal(fs.existsSync(tmpRoot), false);
      if (fs.existsSync(orphanPidFile)) {
        orphanPid = Number(fs.readFileSync(orphanPidFile, "utf8").trim());
      }
      if (orphanPid && orphanPid > 0) {
        assert.equal(processAlive(orphanPid), false, "orphan node must not survive the test");
      }
    } finally {
      const { killProcessesUsingPath } = await import("./premerge-process-utils.mjs");
      if (orphanPid && orphanPid > 0) {
        try {
          process.kill(orphanPid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      if (fs.existsSync(orphanPidFile)) {
        fs.unlinkSync(orphanPidFile);
      }
      killProcessesUsingPath(tmpRoot, "SIGKILL");
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("M1b only: skip -pgid alone still removes TMPDIR for late-writer leg (surviving mutant)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mutant-m1b-only-"));
    try {
      const code = await sigintExitCode(lateWriterLeg, {
        PREMERGE_MUTANT: "M1b",
        IC_PREMERGE_TMPDIR: tmpRoot,
        TMPDIR: tmpRoot,
      });
      assert.equal(code, 130);
      assert.equal(fs.existsSync(tmpRoot), false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("M1b+M6+M7: skip group kill and path kill leaves TMPDIR after late-writer SIGINT", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mutant-m1b-"));
    try {
      const code = await sigintExitCode(lateWriterLeg, {
        PREMERGE_MUTANT: "M1b,M6,M7",
        IC_PREMERGE_TMPDIR: tmpRoot,
        TMPDIR: tmpRoot,
      });
      assert.equal(code, 130);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(fs.existsSync(tmpRoot), true);
    } finally {
      const { killProcessesUsingPath } = await import("./premerge-process-utils.mjs");
      killProcessesUsingPath(tmpRoot, "SIGKILL");
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("M1: skip leg termination leaves TMPDIR after late-writer SIGINT", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mutant-m1-"));
    try {
      await sigintExitCode(lateWriterLeg, {
        PREMERGE_MUTANT: "M1,M6,M7",
        IC_PREMERGE_TMPDIR: tmpRoot,
        TMPDIR: tmpRoot,
      });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(fs.existsSync(tmpRoot), true);
    } finally {
      const { killProcessesUsingPath } = await import("./premerge-process-utils.mjs");
      killProcessesUsingPath(tmpRoot, "SIGKILL");
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("M2: delayed shutdown + no path kill leaves TMPDIR after late-writer SIGINT", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ic-mutant-m2-late-"));
    try {
      await sigintExitCode(lateWriterLeg, {
        PREMERGE_MUTANT: "M2,M6,M7",
        IC_PREMERGE_TMPDIR: tmpRoot,
        TMPDIR: tmpRoot,
      });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(fs.existsSync(tmpRoot), true);
    } finally {
      const { killProcessesUsingPath } = await import("./premerge-process-utils.mjs");
      killProcessesUsingPath(tmpRoot, "SIGKILL");
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("M7: skip process-group kill leaves active leg child alive", async () => {
    const probe = path.join(sdkRoot, "tests/storage/fixtures/premerge-mutant-m7-probe.mjs");
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [probe], {
        cwd: sdkRoot,
        env: { ...process.env, IC_PREMERGE_ALLOW_MUTANT: "1", PREMERGE_MUTANT: "M7" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let buf = "";
      child.stdout?.on("data", (c) => {
        buf += String(c);
      });
      child.on("exit", () => resolve(buf));
      child.on("error", reject);
    });
    assert.match(out, /CHILD_ALIVE/);
  });
});
