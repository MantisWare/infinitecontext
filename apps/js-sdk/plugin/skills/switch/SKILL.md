---
name: switch
description: "Switch current session to codex. InfiniteContext keeps your original context."
allowed-tools:
  - Bash
---

# /switch — Cross-agent session portability by InfiniteContext

Switch your current conversation to another AI agent with full context.

## Usage

`/switch <target>` where target is: `codex` or `claude`

Optional flags: `--last N` (carry only last N messages), `--no-launch` (write session file only)

## Steps

1. Run:
```bash
infinitecontext switch $ARGUMENTS
```

2. If `infinitecontext` is not installed, tell the user: `npm i -g infinitecontext` or `bun add -g infinitecontext`

3. Report: session ID, file path, message count. Codex will open in a new terminal tab automatically.
