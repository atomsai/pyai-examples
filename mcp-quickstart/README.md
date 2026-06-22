# mcp-quickstart — PyAI over Model Context Protocol

Use the PyAI **MCP server** ([`@pyai/mcp`](https://www.npmjs.com/package/@pyai/mcp))
from any MCP host — **Cursor, Claude Code, Codex** — so your AI coding agent can
mint a free key and call PyAI (TTS, STT, voices, realtime) **directly instead of
guessing endpoints**. There is **no human step**: with no key set, the agent
calls `create_sandbox_key` and the server adopts the minted key for the session.

This folder also ships a tiny, zero-dependency script that drives the same server
over stdio, so you can watch it work end to end.

## Run the end-to-end demo (no key needed)

```bash
npm start
```

It spawns `npx -y @pyai/mcp`, performs the MCP handshake, lists the tools, mints
a free **sandbox key** (no email/card), then synthesizes speech to `hello.mp3`.
To use your own key instead, copy `.env.example` to `.env`, set `PYAI_API_KEY`,
and run with `node --env-file=.env index.mjs` (or just `export PYAI_API_KEY=…`).

Prefer Python? The same flow, standard-library only (needs Node on PATH for
`npx`):

```bash
python3 client.py
```

## Wire it into your agent

### Cursor
This folder ships a `.cursor/mcp.json`, so opening it in Cursor enables the
`pyai` server automatically. To enable it everywhere, add the same to
`~/.cursor/mcp.json`:

```json
{ "mcpServers": { "pyai": { "command": "npx", "args": ["-y", "@pyai/mcp"] } } }
```

Add `"env": { "PYAI_API_KEY": "pyai_test_…" }` to pin a key, or leave it out and
let the agent mint a sandbox key.

### Claude Code

```bash
claude mcp add pyai -- npx -y @pyai/mcp
# or pin a key:
claude mcp add pyai --env PYAI_API_KEY=pyai_test_... -- npx -y @pyai/mcp
```

### Codex / other MCP hosts
Point the host at the stdio command `npx -y @pyai/mcp` (optionally with
`PYAI_API_KEY` in the environment). The transport is newline-delimited
JSON-RPC 2.0 over stdio.

## Tools the server exposes

| Tool | Needs a key? | What it does |
|------|--------------|--------------|
| `create_sandbox_key` | No | Mint a free `pyai_test_` key (no email/card); adopted for the session |
| `get_started` | No | Curated quickstart (auth, SDK install, snippets) — no network |
| `whoami` | Yes | Inspect the active key (org, env, scopes, credit) |
| `list_models` / `list_voices` | Yes | Catalog browsing |
| `synthesize_speech` | Yes | Text-to-speech to a file |
| `create_transcription_job` / `get_transcription_job` | Yes | Async speech-to-text |

Docs: https://docs.pyai.com · contract: https://api.pyai.com/openapi.json
