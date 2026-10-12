<p align="center">
  <a href="https://infinitecontext.ai">
    <img src="https://infinitecontext.ai/gh-cover.png" alt="InfiniteContext" />
  </a>
</p>

<h3 align="center">Same context. Everywhere.</h3>

<p align="center">
  Start on Claude Code. Continue on Codex.<br/>
  Open source, realtime and invisible context infrastructure for the ones shipping at inference speed.
</p>

<p align="center">
  <a href="https://infinitecontext.ai/docs">Documentation</a> ·
  <a href="https://infinitecontext.ai/docs/api-reference/introduction">API Reference</a> ·
  <a href="https://infinitecontext.ai/docs/changelog">Changelog</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/infinitecontext">
    <img src="https://img.shields.io/npm/v/infinitecontext" alt="npm version" />
  </a>
  <a href="https://pypi.org/project/infinitecontext/">
    <img src="https://img.shields.io/pypi/v/infinitecontext" alt="PyPI version" />
  </a>
  <a href="https://github.com/MantisWare/infinitecontext/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/MantisWare/infinitecontext" alt="license" />
  </a>
  <a href="https://infinitecontext.ai">
    <img src="https://img.shields.io/badge/Visit-infinitecontext.ai-4B6EF5" alt="Visit infinitecontext.ai" />
  </a>
</p>

<div align="center">
  <a href="https://twitter.com/infinitecontext">
    <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
  </a>
  <a href="https://discord.com/invite/4HjcS6KwhW">
    <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
  </a>
</div>

---

![infinitecontext-gif](https://github.com/user-attachments/assets/be73afe5-161d-4fa3-8f4d-c4987fe63cb4)

What Claude Code knows, Codex doesn't. What your teammate is shipping right now? Your agent has no idea.

InfiniteContext captures every agent's context in realtime and makes it available to all of them. It's like having a personal context engineer everywhere. Continue a session in a different agent, or just ask what's happeming.

For example:

- *"Codex, grab the last plan Claude Code made and implement it."*
- *"What's the team building today?"*
- *"What is Alex working on in Codex right now?"*

Open source. Framework-agnostic. Customizable via the git-like Context API.

## Features

| CLI | Auto-ingest Claude Code, Codex, and OpenClaw sessions with a terminal dashboard. |
| --- | --- |
| MCP Server | Share context everywhere. Built into the API, or run standalone via stdio. |
| Context API | Git-like context engineering API. Store, version, and retrieve agent context with zero complexity. |

---

## How it works

1. **Start sync.** It captures all your agents' context in realtime.

2. **Add the MCP server.** Any agent gets full awareness of every other agent.

3. **That's it.** Ask questions, continue sessions, fork — your context is everywhere.

## Install

Requires Node >= 22.

```bash
npm install -g infinitecontext
```

## Quick Start

```bash
infinitecontext          # start sync (daemon + dashboard)
```

That's it. InfiniteContext watches your agents, ingests context in realtime, and the dashboard shows everything.

```bash
infinitecontext sync     # start sync (daemon + dashboard)
infinitecontext stop     # stop daemon
infinitecontext config   # run setup wizard
infinitecontext update   # update CLI globally
```

## Context API

For builders who want to go deeper. Git-like primitives for context engineering.

- **Five methods** — Create, get, append, update, delete. That's it.
- **Automatic versioning** — Every change creates a new version. Full history out of the box.
- **Time-travel** — Jump to any point in your context history.
- **Framework-agnostic** — Works with any LLM framework. No vendor lock-in.

Use the API standalone to build your own agents, or extend existing ones in InfiniteContext.

| SDK                   | Install                    | Source                               |
| --------------------- | -------------------------- | ------------------------------------ |
| JavaScript/TypeScript | `npm install infinitecontext` | [apps/js-sdk](./apps/js-sdk)         |
| Python                | `pip install infinitecontext` | [apps/python-sdk](./apps/python-sdk) |

### JavaScript/TypeScript

```bash
npm install infinitecontext
```

```typescript
import { InfiniteContext } from 'infinitecontext';

const uc = new InfiniteContext({ apiKey: 'ic_live_...' });

const ctx = await uc.create();
await uc.append(ctx.id, { role: 'user', content: 'Hello!' });

// use with any LLM framework
const response = await generateText({ model, messages: ctx.data });
```

### Python

```bash
pip install infinitecontext
```

```python
from infinitecontext import InfiniteContext

uc = InfiniteContext(api_key="ic_live_...")

ctx = uc.create()
uc.append(ctx["id"], {"role": "user", "content": "Hello!"})

# use with any LLM framework
response = generate_text(model=model, messages=uc.get(ctx["id"])["data"])
```

<p align="center">📚 Context API Guides</p>
<p align="center">
  <a href="https://infinitecontext.ai/docs/guides/store-retrieve-contexts">Store & Retrieve</a>
  ·
  <a href="https://infinitecontext.ai/docs/guides/edit-contexts">Edit Contexts</a>
  ·
  <a href="https://infinitecontext.ai/docs/guides/fork-clone-contexts">Fork & Clone</a>
  ·
  <a href="https://infinitecontext.ai/docs/guides/view-context-history">View History</a>
</p>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=infinitecontext/infinitecontext-node&type=date&legend=top-left)](https://www.star-history.com/#infinitecontext/infinitecontext-node&type=date&legend=top-left)

## Documentation

- [Quickstart](https://infinitecontext.ai/docs/quickstart) — Get running in 2 minutes
- [Guides](https://infinitecontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://infinitecontext.ai/docs/api-reference/introduction) — Full endpoint documentation
