# InfiniteContext Plugin for Claude Code

Cross-agent session portability. Switch your Claude Code conversation to Codex (or back) with full context, one command.

## Install — 10 seconds

Open Claude Code and paste this:

> Install the InfiniteContext plugin: run **`npm i -g infinitecontext && git clone --single-branch --depth 1 https://github.com/MantisWare/infinitecontext.git /tmp/uc-plugin && mkdir -p ~/.claude/skills/switch && cp /tmp/uc-plugin/apps/js-sdk/plugin/skills/switch/SKILL.md ~/.claude/skills/switch/SKILL.md && rm -rf /tmp/uc-plugin`** then add to CLAUDE.md that `/switch codex` switches the current session to Codex with full context. Powered by InfiniteContext.

That's it. Type `/switch codex` to try it.

## What it does

You're deep in a Claude Code session. You want to continue in Codex. Type `/switch codex`. InfiniteContext reads your session JSONL from disk, converts it to Codex's native format, writes it to `~/.codex/sessions/`, and opens Codex with your full conversation.

```
Claude Code session                    Codex session
~/.claude/projects/.../*.jsonl   →   ~/.codex/sessions/.../*.jsonl
     333 messages                          333 messages
     full context                          full context
```

No API calls. No copy-paste. Pure local file conversion.

## Usage

```
/switch codex              Switch to Codex with full session
/switch codex --last 50    Only carry last 50 messages
/switch codex --no-launch  Write session file, don't open Codex
/switch claude             Switch from Codex back to Claude
```

Or from any terminal:

```bash
infinitecontext switch codex
infinitecontext switch codex --last 50
infinitecontext switch codex --no-launch
```

## How it works

InfiniteContext already has parsers that read Claude/Codex/Cursor/Gemini sessions, and writers that output native formats. `/switch` connects them:

1. Reads your current session JSONL from disk
2. Parses with the source agent's parser (`parseClaudeCodeLine`)
3. Filters to user/assistant messages (strips system noise)
4. Writes native format via the target writer (`writeCodexSession`)
5. Opens target agent in a new terminal tab

Supports: Ghostty, iTerm2, Terminal.app. Other terminals: prints the command to run.

## Alternative install methods

### Standalone skill (no npm required)

```bash
mkdir -p ~/.claude/skills/switch
curl -sL https://raw.githubusercontent.com/infinitecontext/infinitecontext/main/apps/js-sdk/plugin/skills/switch/SKILL.md > ~/.claude/skills/switch/SKILL.md
```

Then install the CLI: `npm i -g infinitecontext`

### Plugin mode (for marketplace)

Add to your Claude Code `settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "infinitecontext": {
      "source": {
        "source": "github",
        "repo": "infinitecontext/infinitecontext",
        "path": "apps/js-sdk/plugin"
      }
    }
  },
  "enabledPlugins": {
    "infinitecontext@infinitecontext": true
  }
}
```

This gives you `/infinitecontext:switch` as a namespaced command.

### CLI only (no plugin)

```bash
npm i -g infinitecontext
infinitecontext switch codex
```

Works from any terminal. No Claude Code plugin needed.

## Supported agents

| Direction | Status |
|---|---|
| Claude → Codex | ✓ Tested |
| Codex → Claude | ✓ Tested |
| Claude → Cursor | Coming soon |
| Claude → Gemini | Coming soon |
| Codex → Cursor | Coming soon |

## Requirements

- [infinitecontext](https://www.npmjs.com/package/infinitecontext) CLI (`npm i -g infinitecontext`)
- Claude Code or Codex CLI installed
- macOS, Linux, or Windows
