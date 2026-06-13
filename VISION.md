# MineAgent Vision Document

## Overview

MineAgent is a Minecraft playing agent. It connects to a Minecraft server, behaves like a real client, and acts on goals given to it by the user — through chat, voice, or other input. It is built on top of Mineflayer and runs from a dedicated workspace subdirectory that holds its instructions, skills, scripts, and memories.

The goal is to make the bot easy to run, easy to extend, and easy to inspect.

## Framework

MineAgent is built on the **Mineflayer** framework. Mineflayer is a Node.js library for creating Minecraft clients, and it provides the protocol-level connection, event system, physics, and world primitives that MineAgent relies on.

Mineflayer handles the Minecraft side of the system. MineAgent adds the agent layer on top — chat handling, voice output, browser observation, persistent skills and scripts, and clean shutdown.

## Core Idea

MineAgent should behave like a real Minecraft client from the server's point of view, while acting as a goal-driven agent under the hood.

It should support:

- headless Minecraft connection via Mineflayer
- a built-in set of tools for connecting, observing, and acting
- player chat interaction
- browser-based live observation
- browser text-to-speech voice output
- self-improvement through new scripts and skills
- clean shutdown with commit-on-exit behavior

## Connecting to a Server

MineAgent connects to Minecraft servers through Mineflayer, and the connection model is intentionally simple.

### Authentication

MineAgent only works with servers that **do not authenticate with Mojang**. The bot runs in offline mode and uses Mineflayer to set its own username directly. There is no Microsoft or Mojang account, no session token, and no real-player credential on the bot's side. If a server requires online-mode authentication, MineAgent cannot join it.

This is a hard scope limitation, not a feature to expand later. It keeps the bot simple to run and removes the need to store real credentials.

### Username

The bot's in-game username is passed to Mineflayer as a client option at connect time:

- The **default username is `MineAgent`**, so a fresh run can join an offline-mode server with no extra configuration.
- The user can **override the username** by passing a different value through the connection tool. Whatever the user names the bot, that is the name that appears in chat and on the server.

The username is just a label, not an identity. There is no expectation that it is unique, registered, or special — the server is responsible for enforcing whatever username policy it wants.

### Agent-Driven Connection

The agent is responsible for managing its own connection. It should treat connecting to a server as a first-class task that it can do, ask about, and retry on its own, without the user having to manually start the bot.

In particular:

- If the agent already knows the server address (for example, from a previous run saved in `memories/`, or from a user message earlier in the conversation), it should connect to it.
- If the agent **does not know the IP address or port**, it should **ask the user**. A natural phrasing is "Hey, what's the IP address?" (or "IP and port?"), and once the user provides it, the agent should try to connect.
- The agent should be able to **retry** on connection failure (wrong IP, server offline, version mismatch, kicked, timeout) and decide whether to ask the user again, try a different address from memory, or give up cleanly.

The user should never have to run a separate "start the bot" step. The agent should be able to drive the whole flow from a normal conversation.

### Connection Tools

The agent should have all of the connection-related tools it needs built in, including:

- `connect_to_server` — start a Mineflayer connection given a host, port, and username; reports success, failure, or a **classified error** (unreachable, refused, timeout, auth_required, version_mismatch, not_whitelisted, kicked)
- `disconnect_from_server` — clean shutdown of the current connection
- `set_username` — override the username used for the next connect
- `connection_status` — report the current connection state (connected, disconnected, reconnecting, error)
- `ask_user_for_server` — prompt the user for the IP/port or other connection details the agent is missing
- `connect_to_last_known_server` — re-connect to the server saved in `memories/` from a previous run
- `forget_last_server` — clear the remembered server when the user changes context

In addition to the connection tools, MineAgent should have a **broad in-world action API** so the agent can actually play the world: `move_to`, `stop_moving`, `follow_player`, `look_at_block`, `look_at_position`, `mine_block`, `place_block`, `find_block`, `read_chat_history`, `scan_nearby_entities`, `get_block_info`, `equip_item`, `drop_item`, `use_held_item`, `attack_entity`. Every action tool returns the standard `{ ok, error?, kind? }` envelope and reports a stable `kind` (e.g. `not_connected`, `item_missing`, `target_required`, `no_position`) so the agent can branch on the result without parsing message strings.

## MCP-Based Tool Surface

MineAgent exposes its tools through an **MCP (Model Context Protocol) server** at `src/mcp-server.js`. The MCP server is the single bridge between the persona (or any MCP client) and the Mineflayer stack. The persona never calls into `src/` directly; every action flows through a `tools/call` request to the server.

The server speaks **line-delimited JSON-RPC 2.0 over stdio**, which is the standard MCP transport. It implements the three methods any MCP client needs to drive a tool-using agent:

- `initialize` — handshake; returns the protocol version, server capabilities, and server identity.
- `tools/list` — returns the harness-agnostic tool manifest, with `name`, `description`, and a strict JSON Schema `parameters` object per tool. No provider-specific envelope (no OpenAI `type: "function"`, no Anthropic wrapper); the same shape works for every MCP client.
- `tools/call` — invokes a tool by name with arguments; returns the structured `{ content: [{ type: "text", text }], isError }` result.

The server is started by the start script at `workspace/start-mcp.sh`, which the MCP config at `workspace/.agents/mcp.json` references. The server itself enforces **one instance at a time**: on startup it reads the pidfile at `$MINEAGENT_MCP_PIDFILE` (default `.runtime/mcp-server.pid`), sends SIGTERM to any process recorded there, waits up to 2 seconds, and then writes its own PID. This means re-running the start script is always safe; the previous instance is shut down before the new one starts.

### The broad API

The MCP server's `tools/list` exposes a single, broad API. From the calling perspective there is no distinction between "built-in" tools and "player-written" tools — every tool is just a name, a description, a parameter schema, and an executor reachable through `tools/call`.

The broad API covers:

- **Connection and session.** connect, disconnect, status, set username, ask the user, reconnect to the last server, forget it, shut down.
- **In-world communication.** `send_chat` for chat. TTS is an automatic side effect of every `send_chat` call; the agent never calls a separate speak tool.
- **In-world action.** `move_to`, `stop_moving`, `follow_player`, `look_at_block`, `look_at_position`, `mine_block`, `place_block`, `find_block`, `read_chat_history`, `scan_nearby_entities`, `get_block_info`, `equip_item`, `drop_item`, `use_held_item`, `attack_entity`. Every action helper returns the standard `{ ok, error?, kind? }` envelope and never throws, so the agent loop can branch on the result without try/catch.
- **Bookkeeping.** list/read/write memories; read the last-known server; persist session notes.
- **Skill discovery and read.** list/read skills and scripts; list/read proposals.
- **Skill management (committed).** `propose_skill_change` is the only path to a committed modification to `workspace/skills/` or `workspace/scripts/`. The execute tools (`create_skill`, `update_skill`, `remove_skill`, `create_script`) are gated by an in-session user approval in chat.

Custom tools the persona writes — markdown skills, JS scripts, ad-hoc helpers — have access to the same broad API. When a skill says "first read the `cave-scout` skill, then call `send_chat`", both `read_skill` and `send_chat` are in the broad API, and the persona or any other tool can call them through the MCP server.

### Why MCP and not a custom manifest

The persona is the single, programmatic way to boot the in-world agent: `startPersona({ host?, port?, username?, goal? })` returns a wired-up tool manifest, an attached chat listener, an optional observer handle, and a `callTool` entry point. The CLI is a thin readline wrapper around it.

The MCP server wraps the same `callTool(name, args)` surface in a standard protocol that any MCP client can speak: Codebuff, Claude Desktop, a custom harness, the test runner, the CLI, or a future tool. The persona and the CLI can both speak MCP; the server is the single point of truth for the tool palette.

## Basic Project Layout (minimum, will contain more files)

MineAgent's playing agent lives in a dedicated workspace subdirectory. The rest of the project — the Mineflayer bot code, the browser observer server, the UI, the MCP server, and supporting docs — sits alongside it as the implementation that powers the agent.

### Directory Layout

    MineAgent/                  <- the MineAgent project root
      README.md
      AGENTS.md
      VISION.md
      package.json
      .gitignore
      src/                      <- Mineflayer bot code + MCP server
        index.js                <- CLI entry (readline wrapper around startPersona)
        persona.js              <- programmatic entry point for the in-world agent
        mcp-server.js           <- stdio JSON-RPC MCP server (tools/list, tools/call)
        connection.js
        state.js
        events.js
        improve.js
        tools/                  <- tool registry (manifest, callTool)
        skills/                 <- skills exposed to the agent loop
      server/                   <- browser observer server
      ui/                       <- browser observer UI
      specs/                    <- behavior contracts (root + per-module)
      docs/
      workspace/                <- the playing agent's home
        AGENTS.md               <- operating instructions for the playing agent
        start-mcp.sh            <- starts the MCP server (idempotent)
        .agents/mcp.json        <- MCP server config
        skills/                 <- reusable behaviors
        scripts/                <- reusable helpers (more specific than skills)
        memories/               <- run-local notes (gitignored)

`workspace/` is the playing agent's home. That is where the agent runs from, and that is where it reads its instructions and stores its working files. Keeping the playing agent in its own subdirectory keeps it self-contained and independent of the supporting code.

### What the Workspace Contains

The workspace should be created with a small, clear set of starting contents. Everything else is added by the agent as it works.

Starting contents:

- `AGENTS.md` — the operating instructions for the playing agent, including the active persona or role
- `skills/` — a small initial set of general, reusable skills, for example:
  - movement and navigation (walk to coordinates, follow a player, path to a landmark)
  - chat handling (read chat, respond in chat, parse simple commands)
  - basic world interaction (look at block, mine a block by name, place a block)
  - status reporting (inventory, health, position, current task)
- `scripts/` — empty, ready for reusable helpers the agent may create
- `memories/` — empty, ready for session notes (not committed); includes `last-server.json` for persistent server memory

The agent should not need a long checklist of pre-baked content. It should start lean and grow skills and scripts on demand. New personas or specialized agents can be added later as additional skills that bundle prompts, tools, and behaviors.

### Where Runtime Artifacts Go

Runtime state, logs, caches, credentials, and session artifacts all live under a single `.runtime/` directory inside `workspace/`, which is gitignored. The committed workspace structure only contains the playing agent's general-purpose artifacts. The MCP server's pidfile lives at `.runtime/mcp-server.pid`.

## Memories

`memories/` is the special folder for things that are started during a run and that should never be committed to Git history.

It is the place for:

- session logs and summaries
- plans the agent makes for a run
- reflections on what went well or badly
- notes specific to a particular server, build, or task
- `last-server.json` — the persistent "last known server" memory that powers the vision's "from a previous run saved in memories/" branch
- `proposals/` — pending skill-change proposals (gitignored); the only path to a committed skill or script change

Anything that grows there is local to the run that produced it. The committed skills and scripts should be treated as a shared, general-purpose library. The memories folder is the agent's private notebook.

## Skills and Scripts

Skills are the main reusable behavior units. They should be easy for the agent to discover and use. A skill can also bundle a full persona or specialized agent (prompt, tools, and behavior) so MineAgent can host more than one role over time.

Scripts are reusable helpers for tasks that are more specific than skills. A script might track state across multiple actions (for example, counting blocks placed while building), run a multi-step calculation, or coordinate a sequence of tool calls that is too narrow for a general-purpose skill. Scripts are committed and permanent, just like skills — they are not temporary. The difference from skills is granularity and purpose: a skill describes what to do in a general situation, a script describes how to do a specific thing repeatedly. Scripts are peers of skills, not a lower tier.

Anything in `memories/` that turns out to be generally useful can be promoted into a skill or a script. Promotion is what makes something worth keeping long-term; anything that stays in `memories/` is local to the run that produced it.

## Self-Improvement

MineAgent should be able to improve itself during operation, but the bar for *committed* improvements is high. The playing agent does not own `workspace/` unilaterally; it shares that ownership with the user (another player in the world). The rules below govern what the agent may do on its own, and what it must consult about first.

### Proactive learning

The agent should be **actively curious** about its own performance. Whenever it encounters a situation that a future run of the same kind would also encounter, it should pause and ask itself: would a new tool, a new skill, or a revision of an existing one make this faster, safer, or more reliable next time?

Examples:

- The agent has to navigate parkour to reach a goal. It notices it improvises a different jump pattern every time. → Propose a `parkour` skill that codifies the pattern so future runs start with it.
- The agent repeats the same `pathfind + dig` sequence to escape caves. → Propose a `cave-escape` script that captures the sequence.
- The agent finds a skill that omits a tool it should reference. → Propose a `revise` of the skill to add the missing tool reference.
- The agent notices a skill that is over-specific to a single build or server layout. → Propose to `generalize` or `remove` it.

The user is the agent's partner in this loop, not its auditor. Proposing is encouraged; proposing well is the skill.

### Consult before commit

Committed modifications to `workspace/skills/` and `workspace/scripts/` are **shared state** — they are the persistent library that survives across runs and across servers. The agent does not get to mutate that library on its own.

The flow is:

1. The agent calls `propose_skill_change` with the proposed change (create, revise, remove, or generalize), a `summary` of the change in plain language, and a `reason` explaining the learning opportunity.
2. The proposal is written to `memories/proposals/<name>-<timestamp>.md` (gitignored). The tool returns a chat-prompt string the agent can use to ask the user in-world.
3. The agent describes the proposal to the user via chat (in-character) and waits for an explicit yes/no.
4. On approval, the agent calls the appropriate execute tool (`create_skill`, `update_skill`, `remove_skill`). On rejection, the agent calls `reject_proposal` and the proposal is deleted.

The shutdown handler does **not** auto-promote anything from `memories/proposals/` into `skills/` or `scripts/`. The only path from proposal to commit is an explicit user approval in the same session (or a follow-up session that finds the proposal and asks the user again). Anything left in `memories/proposals/` at shutdown is preserved as a memory and not auto-committed.

### World-agnostic skills

All skills and tools must be **world-agnostic** — they should be useful on any offline-mode Minecraft server, in any build, in any biome. Skills that are specific to a single server, a single player base, a single build (e.g., "build a prismarine tower at coordinates X,Y,Z") are anti-patterns and must be either generalized or removed.

When proposing a new skill, the agent must answer the question: would this skill help a MineAgent persona that has never seen this server? If no, generalize or do not propose.

When proposing a revision, the agent must consider whether the existing skill has drifted toward server-specificity. If so, the revision should generalize it.

### Skill maintenance

The agent's responsibility does not end at creation. Every run is also a maintenance pass. On a regular cadence (and especially before shutdown), the agent should:

- **Audit** each existing skill for staleness. If a tool the skill references has been renamed, removed, or its `error.kind` table has changed, propose a `revise`.
- **Audit** each existing skill for over-specificity. If a skill's example or description is tied to one server, one build, or one coordinate set, propose to `generalize` it (rewrite with abstract references) or `remove` it.
- **Audit** each existing skill for missing relevant references. If a workflow skill could usefully mention a tool the persona has, propose a `revise`. This is a soft trigger, not a hard rule: not every skill needs tool references, and the agent should skip this audit for skills that are pure description, etiquette, or context.

The maintenance pass is part of the persona's normal loop, not a separate task. The agent runs it at the end of any session in which it created or used skills.

Note: not every skill needs to mention a tool. Some skills are pure descriptions of player behavior, etiquette, or context that don't map to a single tool. The agent should use judgment: a workflow skill about parkour, mining, or pathing may benefit from referencing the relevant tool; a skill about chat tone or roleplay probably does not. The maintenance trigger is *would the skill be more useful with a small change*, not *must every skill look like a tool reference page*.

## Chat and Voice

MineAgent should be able to read player chat and respond in chat.

The persona has exactly one in-world voice: `send_chat`. Every `send_chat` call also triggers browser text-to-speech as an internal side effect, so the bot can say voice lines through the web UI. The agent does not need — and is not exposed to — a separate `speak` tool. TTS is invisible to the agent and is a fixed consequence of sending chat.

The single in-world voice helper is `say()` in `src/skills/chat.js`. It validates input, calls `sendChat()` in `src/connection.js`, converts the typed `NotConnectedError` into a `{ ok: false, kind: 'not_connected' }` envelope, and re-throws unknown errors. The `send_chat` MCP tool wrapper and the `/api/say` HTTP route both call `say()` so there is exactly one envelope-conversion point in the codebase.

The browser is the place where the voice is played.

## Browser Observer

MineAgent should expose a browser-accessible server that shows what the agent is doing.

The UI should display:

- current task
- current location
- recent actions
- inventory
- health and status
- chat history
- voice events
- session logs

This is an observer console, not a replacement game client.

## Shutdown Behavior

When the player tells the bot to shut down, MineAgent should:

1. stop taking new work
2. finish or safely stop current actions
3. move any session-specific notes into `memories/`
4. promote only general, reusable improvements into `skills/` or `scripts/`
5. commit the promoted improvements with a special shutdown commit message
6. disconnect cleanly from the server

The shutdown commit should preserve useful self-improvements from the session, while leaving session-specific memories (including `last-server.json`) uncommitted.

## Design Goals

MineAgent should be:

- Mineflayer-based
- headless-first
- observable
- extensible
- clean to shut down
- safe to operate
- easy to resume later
- **MCP-first** — the persona and any external client drive the bot through the MCP server
- **harness-agnostic** — the tool manifest is a strict JSON Schema subset any LLM harness can consume

## Non-Goals

MineAgent is not trying to be:

- a GUI automation demo
- a brittle one-off bot
- a full replacement for a human player
- a wrapper around a single LLM provider

## Success Criteria

MineAgent succeeds if it can:

- run from a single workspace directory
- join a server like a real client using Mineflayer
- read and respond to chat
- speak through browser TTS
- show live state in the browser
- keep session-specific work in a gitignored `memories/` folder
- promote only general improvements into committed `skills/` and `scripts/`
- shut down cleanly and commit only the useful, general changes
- expose its tool palette through an MCP server that any MCP client can drive
- boot the in-world persona through a single `startPersona()` entry point
- classify every connection failure into a stable `error.kind` the agent can branch on
- propose (never unilaterally commit) changes to its shared `skills/` and `scripts/` libraries, after consulting the user
- keep its `skills/` and `scripts/` world-agnostic and up to date with the tools it has
- reach the player-written `skills/` and `scripts/` through the broad API the MCP server exposes
- start the MCP server from a workflow script that is safe to re-run (one instance at a time, pidfile-based)
