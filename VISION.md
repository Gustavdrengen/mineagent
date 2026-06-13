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

## Harness-Agnostic Tool Surface

MineAgent exposes its tools in a **harness-agnostic** shape: a strict JSON Schema subset (`type`, `properties`, `required`, `additionalProperties`) with `name` and `description` on the tool itself. There is no provider-specific envelope (no OpenAI `type: "function"` wrapper, no MCP `inputSchema` rename, no Gemini-specific fields).

A parent agent — whether driven by OpenAI, Anthropic, MCP, Gemini, a custom in-process loop, or a test harness — can consume `getToolManifest()` and call `callTool(name, args)` without coupling to any vendor. Thin adapter layers (one page, not shipped here) map the manifest to the provider of choice.

The persona is the single, programmatic way to boot the in-world agent: `startPersona({ host?, port?, username?, goal? })` returns a wired-up tool manifest, an attached chat listener, an optional observer handle, and a `callTool` entry point. The CLI is a thin readline wrapper around it.

## Basic Project Layout (minimum, will contain more files)

MineAgent's playing agent lives in a dedicated workspace subdirectory. The rest of the project — the Mineflayer bot code, the browser observer server, the UI, and supporting docs — sits alongside it as the implementation that powers the agent.

### Directory Layout

    MineAgent/                  <- the MineAgent project root
      README.md
      AGENTS.md
      VISION.md
      package.json
      .gitignore
      src/                      <- Mineflayer bot code
        index.js                <- CLI entry (readline wrapper around startPersona)
        persona.js              <- programmatic entry point for the in-world agent
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
        skills/                 <- reusable behaviors
        scripts/                <- on-demand helpers
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
- `scripts/` — empty, ready for helper scripts the agent may create
- `memories/` — empty, ready for session notes (not committed); includes `last-server.json` for persistent server memory

The agent should not need a long checklist of pre-baked content. It should start lean and grow skills and scripts on demand. New personas or specialized agents can be added later as additional skills that bundle prompts, tools, and behaviors.

### Where Runtime Artifacts Go

Runtime state, logs, caches, credentials, and session artifacts all live under a single `.runtime/` directory inside `workspace/`, which is gitignored. The committed workspace structure only contains the playing agent's general-purpose artifacts.

## Memories

`memories/` is the special folder for things that are started during a run and that should never be committed to Git history.

It is the place for:

- session logs and summaries
- plans the agent makes for a run
- reflections on what went well or badly
- notes specific to a particular server, build, or task
- `last-server.json` — the persistent "last known server" memory that powers the vision's "from a previous run saved in memories/" branch

Anything that grows there is local to the run that produced it. The committed skills and scripts should be treated as a shared, general-purpose library. The memories folder is the agent's private notebook.

## Skills and Scripts

Skills are the main reusable behavior units. They should be easy for the agent to discover and use. A skill can also bundle a full persona or specialized agent (prompt, tools, and behavior) so MineAgent can host more than one role over time.

Scripts are smaller, more temporary helpers that the agent can create on demand for repetitive or awkward tasks.

Anything in `memories/` that turns out to be generally useful can be promoted into a skill or a script. Promotion is what makes something worth keeping long-term; anything that stays in `memories/` is local to the run that produced it.

## Self-Improvement

MineAgent should be able to improve itself during operation.

Examples:

- create a script for a repeated action
- create a new skill when a task deserves a proper reusable workflow
- write notes in `memories/` for future runs of the same session
- add diagnostics if something is hard to observe

The agent should not need human intervention for every small improvement.

## Chat and Voice

MineAgent should be able to read player chat and respond in chat.

It should also have a speak tool that triggers browser text-to-speech so the bot can say voice lines through the web UI.

The browser should be the place where the voice is played.

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
- **harness-agnostic** — its tool manifest works with any LLM harness

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
- expose its tool palette in a harness-agnostic manifest that any LLM harness can consume
- boot the in-world persona through a single `startPersona()` entry point
- classify every connection failure into a stable `error.kind` the agent can branch on
