# MineAgent Root Spec

This is the behavior contract for MineAgent at the system level. It is derived from `VISION.md` and is the source of truth for what the product should do. If implementation diverges from this spec, the spec is the bug.

## Purpose

MineAgent is a Minecraft playing agent that joins offline-mode servers through Mineflayer, accepts user goals, observes and acts in the world, and improves itself over time.

## Core requirements

1. **Offline-mode only.** MineAgent connects only to servers that do not require Mojang authentication. `auth: 'offline'` is hard-wired.
2. **Default username `MineAgent`.** Override via the `set_username` tool.
3. **Connection is agent-driven.** The agent is responsible for asking the user for an IP/port when it does not know one, retrying on failure, and giving up cleanly.
4. **Five connection tools.** `connect_to_server`, `disconnect_from_server`, `set_username`, `connection_status`, `ask_user_for_server`. The set is closed; new tools are added with spec updates.
5. **Workspace is the playing agent's home.** `workspace/` contains the runtime `AGENTS.md`, `skills/`, `scripts/`, and `memories/`.
6. **Memories are gitignored.** Anything in `workspace/memories/` stays local.
7. **Shutdown commits promote only general improvements.** Session-specific work stays in `memories/`.
8. **Browser observer exists.** A static UI is served by `server/index.js` and reads from `/status`.

## Connection model

The connection state machine has five states: `disconnected`, `connecting`, `connected`, `reconnecting`, `error`. Transitions are recorded in `state.status`. The state is queryable through `connection_status()`.

## Module boundaries

- `src/state.js` — state machine. Read by everyone, written by `src/connection.js`.
- `src/connection.js` — Mineflayer lifecycle. The only module that calls `mineflayer.createBot`.
- `src/tools/index.js` — tool registry. Wraps the connection layer for agent consumption.
- `server/index.js` — observer HTTP server. Reads state; does not write it.
- `workspace/AGENTS.md` — runtime persona and decision loop.
- `workspace/skills/` — reusable behaviors.
- `workspace/scripts/` — reusable helpers (more specific than skills).
- `workspace/memories/` — run-local notes (gitignored).

## Non-goals

- Online Mojang authentication.
- Server hosting.
- A replacement for a real Minecraft client.
- A GUI automation framework.

## Status

- 2026-06-13: Bootstrap. The five connection tools register, the state machine is wired, the observer serves a static page, and `npm run smoke` verifies the module graph loads.
