# MineAgent

A Minecraft playing agent driven by [OpenCode](https://opencode.ai/). MineAgent connects to offline-mode Minecraft servers, accepts goals in chat, observes and acts in the world, talks in chat, speaks through browser TTS, exposes a live observer console, and improves itself over time through skills, scripts, and run-local memories.

The project has two parts:

- **The playing agent** lives in `workspace/`. That is where the agent reads its instructions, stores its skills and scripts, and keeps its session notes.
- **The implementation** lives in `src/`, `server/`, and `ui/`. That is the Mineflayer code, the browser observer, the MCP server, and the static observer UI.

The product vision is in [`VISION.md`](./VISION.md) (user-owned; do not edit from inside the agent). The repository operating manual is in [`AGENTS.md`](./AGENTS.md). The current behavior contracts are in [`specs/`](./specs).

## Quick start

1. **Install OpenCode.** See [opencode.ai](https://opencode.ai/) for installation.
2. **Install Node.js dependencies:**
   ```bash
   npm install
   ```
3. **Launch OpenCode from the project root:**
   ```bash
   opencode
   ```
4. **Select the `mineagent` agent.** If OpenCode shows the agent picker, choose `mineagent` (press `Tab` to cycle primary agents).
5. **Tell the bot what to do.** In the OpenCode prompt, say something like "connect to localhost", "go to 0 64 0", or "mine 5 oak_log". The agent drives the bot through the MCP server.

The bot only connects to servers that run in **offline mode** (no Mojang authentication).

## What MineAgent does

- Connects to offline-mode Minecraft servers through Mineflayer
- Accepts goals in chat and acts on them
- Talks in chat and speaks through browser TTS
- Exposes a live observer console in the browser
- Improves itself through skills, scripts, and memories
- Keeps session-specific work in a gitignored `workspace/memories/` folder
- Promotes only general, reusable improvements into committed `workspace/skills/` and `workspace/scripts/`
- Bootstraps the playing agent through a single `startPersona()` entry point
- Classifies every connection failure into a stable `error.kind` the agent can branch on
- Proposes (never unilaterally commits) changes to its shared skills and scripts, after consulting the user

## How it works

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│     OpenCode     │ ──▶ │   MCP server     │ ──▶ │    Mineflayer    │
│ (LLM harness)    │ ◀── │  (src/mcp-       │ ◀── │   (src/*.js)     │
│  .opencode/      │     │   server.js)     │     │                  │
│  agents/         │     │  stdio JSON-RPC  │     │  Minecraft       │
│  mineagent.md    │     │  2.0 over stdio  │     │  server          │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

- **OpenCode** is the LLM harness. It is the only client that talks to the MineAgent MCP server. The custom MineAgent agent is configured at `.opencode/agents/mineagent.md`.
- **The MCP server** at `src/mcp-server.js` is the bridge between OpenCode and the Mineflayer code. It speaks line-delimited JSON-RPC 2.0 over stdio and exposes the full tool palette. OpenCode prefixes every tool with the server name, so the agent sees tools like `mineagent_connect_to_server`, `mineagent_send_chat`, and `mineagent_move_to`.
- **The Mineflayer code** in `src/` does the actual Minecraft work — connection, chat, movement, mining, inventory, pathfinding, observer events.

The persona's in-process loop and the CLI can also call tools directly through `callTool()` in `src/tools/index.js`. The MCP server is the public surface; the in-process path is the runtime path; both wrap the same `tools` array.

## Repository layout

- `src/` — Mineflayer bot code + MCP server
  - `mcp-server.js` — stdio JSON-RPC 2.0 server that OpenCode drives
  - `persona.js` — programmatic entry point for the in-world agent
  - `index.js` — CLI entry (readline wrapper around `startPersona`)
  - `connection.js`, `state.js`, `events.js`, `improve.js` — supporting modules
  - `tools/` — tool registry (`getToolManifest`, `callTool`)
  - `skills/` — skills exposed to the agent loop (movement, world interaction, in-world, chat, status)
- `server/` — browser observer HTTP/WS server
- `ui/` — browser observer static UI
- `workspace/` — the playing agent's home
  - `AGENTS.md` — runtime operating instructions for the playing agent
  - `start-mcp.sh` — starts the MCP server (idempotent; OpenCode calls this)
  - `skills/` — reusable behaviors (committed)
  - `scripts/` — reusable helpers (committed)
  - `memories/` — run-local notes (gitignored)
- `specs/` — behavior contracts (root + per-module)
- `opencode.json` — OpenCode config (MCP server registration)
- `.opencode/agents/mineagent.md` — custom OpenCode agent

## Development

```bash
npm test           # run the test suite (Node built-in test runner)
npm run smoke      # verify the entry point loads
npm run observer   # start the browser observer on :3000
```

The CLI (`node src/index.js`, or `npm start`) is a thin readline wrapper around `startPersona` for humans who want to drive the bot interactively from a terminal without OpenCode. OpenCode is the primary driver.

## Documentation

- [`VISION.md`](./VISION.md) — the product vision (user-owned)
- [`AGENTS.md`](./AGENTS.md) — the repository operating manual
- [`workspace/AGENTS.md`](./workspace/AGENTS.md) — the playing agent's runtime operating manual
- [`specs/`](./specs) — behavior contracts (root + per-module)
- [OpenCode documentation](https://opencode.ai/docs/) — the LLM harness

## Requirements

- Node.js 20 or newer
- An offline-mode Minecraft server reachable from the host
- [OpenCode](https://opencode.ai/) installed and authenticated
