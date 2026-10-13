// e2e test — spawns the real CLI (`infinitecontext config`) in a pseudo-tty,
// drives it with real keystrokes, waits for each wizard step to render,
// then asserts the final config.json matches expectations.

import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let pty;
try {
  pty = require("node-pty");
} catch {
  pty = null;
}

const describeOnboarding = pty ? describe : describe.skip;

// ── keystroke sequences the wizard expects ───────────────────────

const KEY = {
  enter: "\r",
  up: "\x1B[A",
  down: "\x1B[B",
  right: "\x1B[C",
  left: "\x1B[D",
  esc: "\x1B",
  backspace: "\x7f",
};

// ── paths ────────────────────────────────────────────────────────

// run src entry directly so edits are exercised without rebuilding dist
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(HERE, "..", "src", "cli", "entry.mjs");

// ── tmp HOME per test run — isolates config.json ─────────────────

let HOME_DIR;

before(() => {
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uc-onboarding-e2e-"));
});

after(() => {
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  // reset config AND any seeded agent session dirs between scenarios so
  // project inference starts fresh each run
  for (const sub of [".infinitecontext", ".claude", ".cursor"]) {
    try { fs.rmSync(path.join(HOME_DIR, sub), { recursive: true, force: true }); } catch {}
  }
});

// ── pty driver ───────────────────────────────────────────────────

// spawn the wizard and return helpers to drive it
function spawnWizard() {
  // GitHub Actions sets CI=true; Ink/onboarding PTY output hangs with no data when CI is set.
  const childEnv = {
    ...process.env,
    HOME: HOME_DIR,
    TERM: process.env.TERM || "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
    COLUMNS: "120",
    LINES: "40",
  };
  delete childEnv.CI;

  const proc = pty.spawn(process.execPath, [CLI_ENTRY, "config"], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: path.dirname(CLI_ENTRY),
    env: childEnv,
  });

  let buffer = "";
  let exitCode = null;
  let exitSignal = null;

  proc.onData((data) => { buffer += data; });
  proc.onExit(({ exitCode: code, signal }) => { exitCode = code; exitSignal = signal; });

  // wait until `re` appears in the output since the last mark
  async function waitFor(re, { timeoutMs = 10000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (re.test(buffer)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for ${re} — last buffer tail:\n${buffer.slice(-500)}`);
  }

  // send keys with a small inter-key gap so Ink state updates flush
  async function send(...keys) {
    for (const k of keys) {
      proc.write(k);
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  // clear buffer — useful between steps so waitFor targets new output
  function clearBuffer() { buffer = ""; }

  function waitForExit(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      (function poll() {
        if (exitCode !== null || exitSignal) return resolve({ code: exitCode, signal: exitSignal });
        if (Date.now() > deadline) return reject(new Error(`wizard did not exit within ${timeoutMs}ms`));
        setTimeout(poll, 25);
      })();
    });
  }

  function kill() { try { proc.kill(); } catch {} }

  return { proc, buffer: () => buffer, waitFor, send, clearBuffer, waitForExit, kill };
}

// ── helpers ──────────────────────────────────────────────────────

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(HOME_DIR, ".infinitecontext", "config.json"), "utf8"));
}

// type a string char-by-char
function chars(str) { return [...str]; }

const DEFAULT_URL = "http://127.0.0.1:8787";

const AFTER_WELCOME =
  /Where should InfiniteContext connect|How do you want to authenticate|Context API base URL/;

async function goWelcome(w) {
  await w.waitFor(/Welcome to InfiniteContext/);
  await w.waitFor(/enter to continue/);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (AFTER_WELCOME.test(w.buffer())) return;
    await w.send(KEY.enter);
    try {
      await w.waitFor(AFTER_WELCOME, { timeoutMs: 400 });
      return;
    } catch {
      // Ink may not have attached input yet — retry Enter
    }
  }
  throw new Error(`failed to leave welcome — buffer tail:\n${w.buffer().slice(-500)}`);
}

async function goHostingHosted(w) {
  await w.waitFor(/Where should InfiniteContext connect/);
  await w.send(KEY.enter);
}

async function goHostingSelfHost(w) {
  await w.waitFor(/Where should InfiniteContext connect/);
  await w.send(KEY.down, KEY.enter);
}

async function goUrlDefault(w) {
  await w.waitFor(/Context API base URL/);
  await w.send(KEY.enter);
}

async function goUrlReplace(w, nextUrl) {
  await w.waitFor(/Context API base URL/);
  await w.send(...Array(DEFAULT_URL.length).fill(KEY.backspace));
  await w.send(...chars(nextUrl), KEY.enter);
}

async function goApiKeyMode(w) {
  await w.waitFor(/How do you want to authenticate/);
  await w.send(KEY.enter);
}

async function goLoginMode(w) {
  await w.waitFor(/How do you want to authenticate/);
  await w.send(KEY.down, KEY.enter);
}

async function enterApiKey(w, key) {
  await w.waitFor(/Enter your API key:/);
  await w.send(...chars(key), KEY.enter);
}

async function finishWizardDefaults(w) {
  await w.waitFor(/Which agents should InfiniteContext watch\?/);
  await w.send(KEY.enter);
  await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
  await w.send(KEY.enter);
  await w.waitFor(/Auto-capture mode:/);
  await w.send(KEY.enter);
  await w.waitFor(/Launch the TUI dashboard\?/);
  await w.send(KEY.down, KEY.enter);
  await w.waitForExit();
}

// ── tests ────────────────────────────────────────────────────────

describeOnboarding("onboarding wizard e2e (real CLI, real pty)", () => {
  it("self-host + all defaults writes full-capture config", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingSelfHost(w);
      await goUrlReplace(w, "https://api.example.com");
      await goApiKeyMode(w);
      await enterApiKey(w, "ic_test_abcdef123456");
      await finishWizardDefaults(w);
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.apiKey, "ic_test_abcdef123456");
    assert.equal(cfg.baseUrl, "https://api.example.com");
    assert.deepEqual(cfg.captureAgents, ["claude", "codex", "cursor"]);
    assert.deepEqual(cfg.projectPaths, []);
    assert.equal(cfg.bootstrapMode, "all");
  });

  it("custom server + codex-only + one specific project + future-only", async () => {
    // seed an inferred project so the picker has something real to select
    const realProject = path.join(HOME_DIR, "Code", "demo-cloud");
    fs.mkdirSync(realProject, { recursive: true });
    const session = path.join(HOME_DIR, ".claude", "projects", "demo-session");
    fs.mkdirSync(session, { recursive: true });
    fs.writeFileSync(
      path.join(session, "01.jsonl"),
      JSON.stringify({ cwd: realProject, type: "user" }) + "\n",
    );

    const w = spawnWizard();
    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);

      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("ic_live_cloudkey99"), KEY.enter);

      // agents — untoggle Claude and Cursor, leave only Codex
      await w.waitFor(/Which agents should InfiniteContext watch\?/);
      await w.send(KEY.down, " ");
      await w.send(KEY.down, KEY.down, " ", KEY.enter);

      // projects — focus starts on "All projects". Move down to the specific one,
      // space toggles it (and auto-unchecks "All"), enter confirms.
      await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
      await w.send(KEY.down, " ", KEY.enter);

      // capture mode — future_only (row 2)
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.down, KEY.enter);

      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);
      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.apiKey, "ic_live_cloudkey99");
    assert.equal(cfg.baseUrl, "https://api.infinitecontext.ai");
    assert.deepEqual(cfg.captureAgents, ["codex"]);
    assert.deepEqual(cfg.projectPaths, [realProject]);
    assert.equal(cfg.bootstrapMode, "new_only");
  });

  it("hosted + account login shows vault init offer", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goLoginMode(w);
      await w.waitFor(/Initialize vault after you sign in/);
      await w.send(KEY.enter);
      await finishWizardDefaults(w);
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.vaultInitRecommended, true);
    assert.equal(cfg.baseUrl, "https://api.infinitecontext.ai");
  });

  it("rejects malformed api key then accepts a valid one", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);

      // key — bad input
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("nope-bad-key"), KEY.enter);

      // wizard shows error text and stays on key step
      await w.waitFor(/Key must start with ic_live_ or ic_test_/);

      // clear the bad input and type a valid one
      await w.send(...Array(12).fill(KEY.backspace));
      await w.send(...chars("ic_test_ok"), KEY.enter);

      // advance through remaining steps using defaults
      await w.waitFor(/Which agents should InfiniteContext watch\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.apiKey, "ic_test_ok");
  });

  it("Esc walks back and lets user change the URL before finishing", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingSelfHost(w);
      await goUrlReplace(w, "http://wrong.example");
      await goApiKeyMode(w);
      await w.waitFor(/Enter your API key:/);
      await w.send(KEY.esc, KEY.esc);
      await w.waitFor(/Context API base URL/);
      await w.send(...Array("http://wrong.example".length).fill(KEY.backspace));
      await w.send(...chars("https://api.corrected.com"), KEY.enter);
      await goApiKeyMode(w);
      await enterApiKey(w, "ic_test_backnav");
      await finishWizardDefaults(w);
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.baseUrl, "https://api.corrected.com");
    assert.equal(cfg.apiKey, "ic_test_backnav");
  });

  it("agents multi-select — untoggle one, keep the other two", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);

      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("ic_test_multi"), KEY.enter);

      // default is all three checked — move focus to Cursor (row 4) and untoggle
      await w.waitFor(/Which agents should InfiniteContext watch\?/);
      await w.send(KEY.down, KEY.down, KEY.down, " ", KEY.enter);

      await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.deepEqual(cfg.captureAgents, ["claude", "codex"]);
  });

  it("agents multi-select — refuses to advance with zero selected", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("ic_test_zero"), KEY.enter);

      // focus starts on "All" — space toggles everything off, then try to advance → error
      await w.waitFor(/Which agents should InfiniteContext watch\?/);
      await w.send(" ", KEY.enter);
      await w.waitFor(/Select at least one agent/);

      // move focus to Codex (row 3), toggle on, confirm
      await w.send(KEY.down, KEY.down, " ", KEY.enter);
      await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.deepEqual(cfg.captureAgents, ["codex"]);
  });

  it("left-arrow steps back just like Esc", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingSelfHost(w);
      await goUrlReplace(w, "https://api.left.test");
      await goApiKeyMode(w);
      await w.waitFor(/Enter your API key:/);
      await w.send(KEY.left);
      await w.waitFor(/How do you want to authenticate/);
      await w.send(KEY.left);
      await w.waitFor(/Context API base URL/);
      await w.send(KEY.enter);
      await goApiKeyMode(w);
      await enterApiKey(w, "ic_test_left");
      await finishWizardDefaults(w);
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.baseUrl, "https://api.left.test");
    assert.equal(cfg.apiKey, "ic_test_left");
  });

  it("'All' shortcut (row 1) toggles every agent at once", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("ic_test_all"), KEY.enter);

      // focus on "All" row. space clears all, space again re-checks all. enter confirms.
      await w.waitFor(/Which agents should InfiniteContext watch\?/);
      await w.send(" ", " ", KEY.enter);

      await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.deepEqual(cfg.captureAgents, ["claude", "codex", "cursor"]);
  });

  it("preserves typed API key when stepping back to mode and forward again", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("ic_test_pers"));
      await w.send(KEY.left);
      await w.waitFor(/How do you want to authenticate/);
      await w.send(KEY.enter);
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("isted"), KEY.enter);
      await finishWizardDefaults(w);
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.equal(cfg.apiKey, "ic_test_persisted");
  });

  it("arrow keys in the agents step don't silently untoggle rows", async () => {
    const w = spawnWizard();

    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("ic_test_arrows"), KEY.enter);

      // move cursor around with arrow keys — should NOT change any selection
      await w.waitFor(/Which agents should InfiniteContext watch\?/);
      await w.send(KEY.down, KEY.down, KEY.down, KEY.up, KEY.up, KEY.up, KEY.enter);

      await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
      await w.send(KEY.enter);
      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);

      await w.waitForExit();
    } finally {
      w.kill();
    }

    // defaults preserved — all three agents still checked
    const cfg = readConfig();
    assert.deepEqual(cfg.captureAgents, ["claude", "codex", "cursor"]);
  });

  it("picker shows inferred projects alongside the 'All projects' row", async () => {
    // seed the tmp HOME with two fake claude sessions recording real cwds
    const p1 = path.join(HOME_DIR, "Code", "alpha");
    const p2 = path.join(HOME_DIR, "Code", "beta");
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p2, { recursive: true });
    fs.mkdirSync(path.join(HOME_DIR, ".claude", "projects", "s1"), { recursive: true });
    fs.mkdirSync(path.join(HOME_DIR, ".claude", "projects", "s2"), { recursive: true });
    fs.writeFileSync(
      path.join(HOME_DIR, ".claude", "projects", "s1", "01.jsonl"),
      JSON.stringify({ cwd: p1 }) + "\n",
    );
    fs.writeFileSync(
      path.join(HOME_DIR, ".claude", "projects", "s2", "01.jsonl"),
      JSON.stringify({ cwd: p2 }) + "\n",
    );

    const w = spawnWizard();
    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("ic_test_pick"), KEY.enter);
      await w.waitFor(/Which agents should InfiniteContext watch\?/);
      await w.send(KEY.enter);

      await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
      // both inferred rows rendered — match just a trailing chunk since long paths
      // may get truncated by ink when the 60-col TitledBox runs out of room
      await w.waitFor(/Code\/alpha|Code\/beta/);
      // focus starts on "All projects" (default-checked). Move to row 2, toggle
      // the specific project (auto-unchecks "All"), then confirm.
      await w.send(KEY.down, " ", KEY.enter);

      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);
      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    // exactly one path selected — either alpha or beta depending on recency order
    assert.equal(cfg.projectPaths.length, 1);
    assert.ok([p1, p2].includes(cfg.projectPaths[0]));
  });

  it("accepts 'All projects' even when nothing could be inferred", async () => {
    const w = spawnWizard();
    try {
      await goWelcome(w);
      await goHostingHosted(w);
      await goApiKeyMode(w);
      await w.waitFor(/Enter your API key:/);
      await w.send(...chars("ic_test_all"), KEY.enter);
      await w.waitFor(/Which agents should InfiniteContext watch\?/);
      await w.send(KEY.enter);

      // no .claude/projects seeded → picker only shows "All projects" row
      await w.waitFor(/Which projects should InfiniteContext auto-capture\?/);
      await w.waitFor(/no recent Claude\/Cursor projects found/);
      await w.send(KEY.enter);

      await w.waitFor(/Auto-capture mode:/);
      await w.send(KEY.enter);
      await w.waitFor(/Launch the TUI dashboard\?/);
      await w.send(KEY.down, KEY.enter);
      await w.waitForExit();
    } finally {
      w.kill();
    }

    const cfg = readConfig();
    assert.deepEqual(cfg.projectPaths, []);
  });
});
