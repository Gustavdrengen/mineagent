# MineAgent AGENTS.md

The operating manual for the MineAgent repository. This file describes how work happens here. The product itself is described in `VISION.md`; the user owns that file and this agent does not modify it.

## Mission

MineAgent is a Minecraft playing agent built on Mineflayer. It connects to offline-mode servers, accepts user goals, observes and acts in the world, talks in chat, speaks through browser TTS, exposes a live observer console, and improves itself over time through skills, scripts, and memories. See `VISION.md` for the full vision.

## Repository layout

```
MineAgent/                  repository root
├── VISION.md               user-owned product vision (read-only to this agent)
├── AGENTS.md               this file — the operating manual
├── README.md               project overview
├── package.json            Node.js project manifest
├── specs/                  behavior contracts (root + per-module)
├── src/                    Mineflayer bot code (connection, state, tools)
│   └── tools/              built-in connection tools
├── server/                 browser observer HTTP/WS server
├── ui/                     browser observer static UI
├── workspace/              playing agent's home
│   ├── AGENTS.md           runtime operating instructions for the playing agent
│   ├── skills/             reusable behavior units (markdown)
│   ├── scripts/            reusable helpers (more specific than skills)
│   └── memories/           gitignored run-local notes
├── docs/                   explanatory material
└── .runtime/               gitignored runtime artifacts
```

`workspace/` is the playing agent's home. The committed part of `workspace/` holds the general-purpose agent artifacts. Anything run-specific lives in `workspace/memories/` and is gitignored.

## Role of VISION.md

`VISION.md` is the only file that represents the user's product vision. It is read-only to this agent. The agent reads it, identifies the next useful work, and implements in accordance with it. If a direct instruction from the user conflicts with the vision, the vision wins, and the conflict is surfaced as a vision-hole alert rather than silently overridden.

## Decision hierarchy

When deciding what to do, in order:

1. System and safety constraints.
2. The user's direct instruction in the current conversation.
3. `VISION.md`.
4. `AGENTS.md`.
5. Other repository docs (`specs/`, `docs/`).
6. Existing code conventions.
7. General best practice.

The user owns the vision. The agent owns implementation, structure, standards, tooling, workflows, maintenance, and repository hygiene.

## Autonomy

The agent does not present plans or request approval outside of vision work. The agent picks the next task per the priority tiers, makes reasonable decisions, documents non-obvious ones via the decision-recording format, and moves on. Questions to the user are reserved for vision creation or modification.

## Priority tiers

All work falls into one tier, in strict order. Do not work on a lower tier while a higher tier has unresolved items, unless the higher tier is genuinely blocked on a vision decision (in which case surface the block as a vision hole).

- **Tier 0 — Product is broken or unplayable.** Bot crashes on connect, core loop is non-functional, required tools are missing, smoke checks fail. Fix immediately. Do not add new features.
- **Tier 1 — Product is painful or empty.** Bot joins but is silent, no chat, no way to give it a goal, observer is blank, shutdown is unclean. Resolve before adding new content.
- **Tier 2 — Missing capabilities explicitly in the vision.** Features the vision says MineAgent should have that don't exist yet. Resolve in vision order.
- **Tier 3 — Polish, depth, nice-to-haves.** Visual polish, additional content beyond the vision, refactors for elegance. Resolve opportunistically.

## State-of-play gate

Before selecting the next task, and again after any break, do all of:

1. **Build and run the project.** Confirm it boots and exits cleanly.
2. **Exercise the product as a user would.** For MineAgent, that means running the smoke test (or actually connecting to a server, if one is available) and confirming the connection tool works.
3. **Write a short, dated entry under `## State of play` below.** Three sections: what works, what is broken/rough/missing in a way a user would notice, what is "there" but feels bad to use. Append, do not overwrite.

The state-of-play note is the source of truth for what the product does today.

## Commit policy

- One logical change per commit.
- Commit at every coherent checkpoint: after a new feature, a bug fix, a refactor, a spec, a doc, a test, a config change, before a new unrelated task, and before ending a session.
- Use a consistent commit style. The default subject is a short imperative sentence; the body records decisions in the format below when applicable.
- Do not bundle unrelated work. Do not defer a commit because more is coming.
- A session that ends with zero commits is a failure mode.

## Decision recording

For any non-obvious, precedent-setting, or surprise-to-the-user decision, record it inline in the commit message, the code, or `AGENTS.md` using this one-liner format:

> **Decision:** [one-sentence description]. **Tier:** T0/T1/T2/T3. **Evidence:** [state-of-play bullet, file path, test result, or run output]. **Trade-off:** [what is deferred and why, if anything].

The trade-off line is mandatory when the chosen action is not the most obvious one. Tier and evidence are always required.

Examples of good decisions:

> **Decision:** Default to ESM (`"type": "module"`) in `package.json`. **Tier:** T2. **Evidence:** Node 22.13 is installed, Mineflayer 4.17 supports ESM imports. **Trade-off:** Older Node versions (< 20) are not supported by this project.

> **Decision:** Use Node's built-in `node:test` runner for the test suite. **Tier:** T2. **Evidence:** No test framework in repo yet, Node 22 ships a stable test runner, zero extra deps. **Trade-off:** Lacks some ergonomic helpers from Vitest/Jest; can be layered on later if needed.

Examples of bad decisions (do not write these):

> **Decision:** Used `any` for the state object. (no evidence, no tier)

> **Decision:** Skipped tests for the connection module. (no trade-off, no test tier bound to the change)

## Session-done checklist

A work session is done only when all of the following are true:

1. All Tier 0 and Tier 1 items in the state-of-play note are resolved, or blocked on a surfaced vision decision.
2. All in-flight work is committed.
3. Build, tests, and smoke checks all pass.
4. The state-of-play note is updated with a dated entry.
5. The next session has a clear, evidenced starting point.

A session that adds Tier 2/3 work while Tier 0/1 is open is not done.

## Git identity

The project is committed to by the project's agent identity, not a personal one:

- Name: `MineAgent Agent`
- Email: `mineagent-agent@local`

Set on the repository, not globally.

## Workflow conventions

- **Specs first for non-trivial work.** A feature that the vision mandates but the repo lacks a spec for should grow a spec under `specs/` before or alongside implementation.
- **Tests bound to tier.** Tier 0 fixes need a regression test. Tier 1 fixes need a playtest observation in the state-of-play note. Tier 2 features need a test derived from the spec.
- **No Mojang auth.** MineAgent connects only to offline-mode servers. `auth: 'offline'` is non-negotiable.
- **Default username is `MineAgent`.** Override via the `set_username` tool.
- **Memories stay local.** Anything under `workspace/memories/` is gitignored and never committed.
- **Shutdown commits promote only general improvements.** Session-specific notes stay in `memories/`.
- **OpenCode is the only harness.** The MCP server, the tool manifest, and the persona are all configured for OpenCode (via `workspace/opencode.json` and `workspace/.opencode/agents/mineagent.md`). Other harnesses (Codebuff, Claude Desktop, custom adapters) are out of scope. The user runs `opencode` from `workspace/`.

## Current State of play

Append dated entries below. Do not delete old observations — they make trends visible.

### 2026-06-13 — initial bootstrap

What works:
- Repository directory layout matches the VISION.
- `AGENTS.md` is in place with priority tiers, state-of-play gate, session-done checklist, and decision-recording format.
- `package.json` declares Mineflayer 4.x and uses ESM.
- `.gitignore` excludes `node_modules/`, `.runtime/`, and `workspace/memories/`.
- `src/connection.js` exposes a `connectToServer`/`disconnectFromServer`/`getStatus`/`setUsername` API over Mineflayer's `createBot`.
- `src/tools/` registers the five vision-mandated connection tools (`connect_to_server`, `disconnect_from_server`, `set_username`, `connection_status`, `ask_user_for_server`).
- `server/` and `public/` ship a minimal browser observer stub (HTTP + static page).
- `workspace/` ships a runtime `AGENTS.md` plus four starter skills and a `memories/` `.gitkeep`.
- `specs/root-spec.md` and `specs/connection.md` describe the current behavior contract.
- Smoke test (`npm run smoke`) loads the entry point without throwing and prints expected status.

What is broken / rough / missing in a way a user would notice:
- The smoke test does not actually open a TCP connection; it only verifies the module loads. Live connect requires a reachable offline-mode server (out of scope for this bootstrap).
- The browser observer is a static page; live state streaming is not wired up yet.
- `ask_user_for_server` is implemented as a CLI prompt, not as an interactive agent tool. Wiring it into an agent loop is a follow-up.
- No automated tests beyond the load smoke check.

What is "there" but feels bad to use:
- The five connection tools are plain functions, not a discoverable registry with descriptions. They will need a tool-spec surface once an agent loop is added.
- `connection.js` mixes Mineflayer event handling with our state machine; the boundary will benefit from a thin adapter once the agent loop is added.

### 2026-06-13 — consult-before-commit self-improvement, proposal workflow, world-agnostic skills, maintenance pass

What works:
- `propose_skill_change` is the only entry point for committed modifications to `workspace/skills/` and `workspace/scripts/`. The tool writes a structured proposal to `memories/proposals/<name>-<timestamp>.md` (gitignored) and returns a `chatPrompt` string the persona echoes in chat to the user.
- After explicit user approval in chat, the persona calls the matching execute tool: `create_skill`, `update_skill`, `remove_skill`, or `create_script`. On rejection, `reject_proposal` marks the proposal (or `read_proposal` + manual review) is the diagnostic path.
- New helpers: `list_proposals`, `read_proposal`, `reject_proposal`. All under the harness-agnostic tool manifest.
- `create_skill` and `create_script` descriptions now warn the LLM that they are committed modifications requiring prior `propose_skill_change` + user approval.
- `removeSkill` returns `removed: true` only if the file actually existed. No-op calls against missing files return `removed: false`.
- `writeLastServer` is the only writer of `memories/last-server.json` (called from `connectToServer` in connection.js). Empty string host/port/username are no-ops, not wipes.
- VISION.md, workspace/AGENTS.md, and specs/tools.md are consistent on the new rules: proactive learning, consult-before-commit, world-agnostic skills, and a maintenance pass with priority `staleness → over-specificity → optional tool-reference additions` (the last is a soft judgment call, not a hard rule).
- 114 tests passing (`npm test`). Smoke check OK (`npm run smoke`).
- Codebase clean: no dangling references, all references to the deleted `diagnose-connection.md` are gone.

What is broken / rough / missing in a way a user would notice:
- The persona has no `!approve <name>` / `!reject <name>` chat command yet, and no smalltalk yes/no route. The user has to respond to the proposal in chat in a way the persona can interpret; for LLM-driven loops this is natural, for the CLI's deterministic `runGoal` path the user has to phrase the approval as a free-text reply that the agent loop can match.
- The shutdown handler still auto-commits anything in `workspace/skills/` and `workspace/scripts/`. The new rule says committed modifications require user approval; the auto-commit path is now in tension with that. A follow-up should make shutdown only commit files that have a matching approved proposal.
- `propose_skill_change` returns a `chatPrompt` string but does not itself emit a chat event. The persona has to remember to call `sendChat` afterward (or the new flow can grow a thin emit wrapper inside the tool).

What is "there" but feels bad to use:
- The dynamic import in two of the new `update_skill` / `remove_skill` tests is redundant with the top-level static import in test/tools.test.js. Stylistic, not a bug.
- The new tests duplicate the `test('cleanup', ...)` pattern at the end of test/tools.test.js. Node's runner runs both; not a failure, but cleaner would be a single shared cleanup.

### 2026-06-13 — MCP-first architecture, broad tool API, workflow moved to workspace

What works:
- The persona, the CLI, and any MCP client (Codebuff, Claude Desktop, a custom harness, the test runner) all drive MineAgent through a single stdio JSON-RPC 2.0 server at `src/mcp-server.js`. The launch surface is `workspace/start-mcp.sh` + `workspace/.agents/mcp.json`. The server enforces "one instance at a time" via a pidfile and SIGTERMs any previous owner on startup. Re-running the start script is always safe.
- The MCP server's `tools/list` exposes a broad API: connection and session tools, in-world communication (`send_chat`, `speak`), bookkeeping (list/read/write memories, last-known server), skill discovery and read (list/read skills, scripts, proposals), and skill management (`propose_skill_change` + gated `create_skill` / `update_skill` / `remove_skill` / `create_script`). The persona and the player-written tools are peers at the tool-call layer.
- New tools in the registry: `send_chat` (in-world voice, kind=not_connected on failure), `read_skill`, `read_script`, `read_memory` (so the persona can pull in player-written content through the MCP server). `send_chat` uses best-effort kind inference from the error message; a typed `NotConnectedError` from `connection.js` would make this reliable.
- The MCP server's lifecycle is sound: `writePidfile` on startup, SIGTERM with 2s grace, SIGKILL fallback, pidfile removed on SIGINT/SIGTERM/exit/uncaughtException/unhandledRejection. Stale pidfiles (from `kill -9`) are detected and overwritten on next start.
- `workspace/AGENTS.md` is rewritten to be crystal clear: the single most important rule is that the persona communicates with Minecraft *only* through the MCP server, never through `../src/` directly. The broad API table is grouped by category (connection, in-world, bookkeeping, skill discovery/read, skill management). The "Custom tools and the broad API" section explains that player-written skills have the same access.
- VISION.md's "Harness-Agnostic Tool Surface" section is replaced with "MCP-Based Tool Surface", with a "Why MCP and not a custom manifest" subsection. Project layout, design goals, and success criteria updated.
- `specs/mcp.md` is the new behavior contract for the MCP server (transport, methods, manifest shape, tool call shape, lifecycle, JSON-RPC error codes, server identity, self-test list).
- `src/persona.js` documents the boundary explicitly: the persona's in-process loop imports `callTool` directly (runtime path), while the MCP server is the public surface for any external LLM harness. Both wrap the same `tools` array.
- 124/124 tests passing (`npm test`). Smoke check OK (`npm run smoke`).

What is broken / rough / missing in a way a user would notice:
- The shutdown handler still auto-commits anything in `workspace/skills/` and `workspace/scripts/` via `commitImprovements`, which is in tension with the new consult-before-commit flow. The state-of-play entry flags this for the next session; the gate needs to move to only commit files with a matching approved proposal, or to emit a chat summary instead of committing.
- `workspace/AGENTS.md` "Sources of truth" still says "Do not call into it directly — go through the MCP server" without a one-line cross-reference to the `src/persona.js` note about the in-process `callTool` being the one explicit exception. A future reader will hit the apparent contradiction. Cheap to add.
- `send_chat` kind inference is a string match on the error message (`message.includes('not connected') || message.includes('no bot')`). Will silently break the day the connection layer rewrites its error text. A typed error class from `connection.js` would fix this.

What is "there" but feels bad to use:
- The MCP server's real subprocess test (the last test in `test/mcp-server.test.js`) spawns a real `node src/mcp-server.js` and filters out `DeprecationWarning` lines from stderr. The filter is robust to Node version changes now, but a future feature that legitimately needs to write to stderr (e.g., a startup progress line) will silently confuse this test. A `MA_VERBOSE=1` env var or a dedicated log channel would be cleaner.

### 2026-06-13 — test pollution cleanup

What works:
- `test/_memories-cleanup.js` is a shared helper. `trackMemory(path)` registers a file for cleanup; the first call auto-installs a `process.on('exit')` hook that removes every tracked file when the test process exits. The hook is the safety net for assertion failures (the runner unwinds, `exit` fires, `unlinkSync` runs). A caveat comment warns future test authors that the hook only fires when the event loop is empty, so any spawned children must be awaited.
- `test/shutdown.test.js` (the `writeSessionSummary` and `shutdown` tests) and `test/improve.test.js` (the `writeMemory` and `list functions` tests) now call `trackMemory(r.path)` and wrap their bodies in `try/finally` with a synchronous `unlinkSync`. The manual unlink keeps the workspace clean *between* tests during a single run; the exit hook is the assertion-failure safety net.
- `test/smoke.js` also uses `trackMemory` for the `smoke-test-memo` so the smoke run is covered by the same safety net.
- `workspace/memories/` is clean: only `README.md`, `.gitkeep`, and the empty `proposals/` directory remain. The 110 test-created `session-*.md` files (all `exitReason: 'unit test'`) have been removed.
- 124/124 tests passing (`npm test`). Smoke check OK (`npm run smoke`).

What is broken / rough / missing in a way a user would notice:
- None new. The shutdown-handler/commitImprovements tension and the `send_chat` error-kind string match noted in the prior state-of-play entry are still open.

What is "there" but feels bad to use:
- The `try/finally` + manual `unlinkSync` pattern is repetitive across the four updated tests. A small `withMemoryCleanup(fn)` wrapper could collapse it, but the explicit `trackMemory` + `unlinkSync` makes the create-and-cleanup boundary obvious at the call site, which is the higher-value readability trade-off.

### 2026-06-13 — fix MCP tools/list wire format: parameters -> inputSchema

What works:
- The MCP server's `tools/list` response now conforms to the MCP 2024-11-05 wire format. The argument schema field is `inputSchema` (camelCase), the value is a real JSON Schema object with `type: "object"`, `additionalProperties: false`, `properties`, and `required`. MCP clients that validate the response with a strict Zod schema (Codebuff, Claude Desktop, etc.) accept the manifest.
- The rename happens at the MCP server boundary, not in the registry. `getToolManifest()` in `src/tools/index.js` still returns `{ name, description, parameters }` — that is the harness-agnostic name. The MCP server's `tools/list` handler maps `parameters` -> `inputSchema` on the way out. The registry is unchanged; the persona's in-process `callTool` path and any future OpenAI/Anthropic/Gemini adapter at the same boundary do their own renames.
- A new strict regression test in `test/mcp-server.test.js` (`tools/list manifests conform to the MCP 2024-11-05 wire format`) JSON round-trips the response and asserts on every required MCP field. The test fails on the old code (`inputSchema` is `undefined`) and passes on the new code. The old `parameters` field is explicitly asserted absent on the wire.
- `specs/mcp.md` tool manifest section updated; a new "Why `inputSchema` and not `parameters`" subsection documents the rename boundary and why the registry is unchanged.
- 125/125 tests passing (`npm test`). Smoke check OK (`npm run smoke`).

What is broken / rough / missing in a way a user would notice:
- None new. The shutdown-handler/commitImprovements tension and the `send_chat` error-kind string match noted in the previous state-of-play entry are still open.

What is "there" but feels bad to use:
- The new wire-format test and the existing manifest test overlap in coverage (both check `inputSchema.type === "object"` and the absence of `execute`). The new test is intentionally stricter — it round-trips through JSON to catch non-serializable values, and it asserts the old `parameters` field is absent. The duplication is a small price for the regression-net property of the new test; it is the one that would have caught this bug.

### 2026-06-14 — rewrite README to reflect OpenCode launch flow

What works:
- README.md is rewritten end-to-end. The old quick start (`npm start`) was wrong — `npm start` runs the readline CLI, not the OpenCode-driven agent. The new quick start is the actual launch flow: install OpenCode, `npm install`, `opencode` from the project root, select the `mineagent` agent, talk to the bot.
- README now has seven sections: Quick start, What MineAgent does, How it works (with an ASCII architecture diagram), Repository layout, Development, Documentation, Requirements. The two-part project structure (playing agent in `workspace/` vs implementation in `src/`+`server/`+`ui/`) is stated up front.
- The CLI (`node src/index.js` / `npm start`) is correctly described in the Development section as a thin readline wrapper for humans who want to drive without OpenCode. OpenCode is the primary driver.
- The "What MineAgent does" list mirrors the VISION.md success criteria. The Repository layout section points at the new OpenCode-specific files (`opencode.json`, `.opencode/agents/mineagent.md`).
- The "Requirements" section calls out Node 20+, an offline-mode Minecraft server, and OpenCode installed and authenticated. No more "just npm install and go".
- 122/122 tests passing (`npm test`). Smoke check OK (`npm run smoke`).

What is broken / rough / missing in a way a user would notice:
- None new. The shutdown-handler/commitImprovements tension and the `send_chat` error-kind string match noted in earlier state-of-play entries are still open.

What is "there" but feels bad to use:
- The ASCII architecture diagram uses box-drawing characters that may not render correctly in all terminal widths. A future cleanup could swap it for a mermaid diagram or a plain-text description, but the current diagram is readable in the typical 100-column terminal and in GitHub's markdown renderer.

### 2026-06-14 — switch from harness-agnostic MCP to OpenCode-only

What works:
- MineAgent is now driven exclusively by **OpenCode** as its single LLM harness. The MCP server, the tool manifest, and the persona are all configured for OpenCode; other harnesses (Codebuff, Claude Desktop, custom adapters) are out of scope.
- `workspace/opencode.json` is the OpenCode config (the user runs `opencode` from `workspace/`). It uses OpenCode's `mcp` key (not the older `mcpServers` key) with `type: "local"` and a `command` array that launches `bash start-mcp.sh` from the same directory. OpenCode prefixes every tool with the server name, so the agent sees `mineagent_connect_to_server`, `mineagent_send_chat`, etc.
- `workspace/.opencode/agents/mineagent.md` is the custom OpenCode agent. It has YAML frontmatter (`description`, `mode: primary`, `temperature`, `steps`, `permission` with `edit: ask`, `bash: ask`, `read: allow`, `websearch: deny`, `mineagent_*: allow`) and a body that is the system prompt. The `model` field is omitted so the agent inherits the user's globally configured model. The body sets up the persona, explains the MCP server boundary, and points at `workspace/AGENTS.md` for the full operating manual.
- `workspace/.agents/mcp.json` is removed. The `.agents/` directory is removed too. The start script `workspace/start-mcp.sh` is unchanged and is still the single boot surface.
- VISION.md's "MCP-Based Tool Surface" section is replaced with "OpenCode MCP Tool Surface". Project layout, design goals, and success criteria updated. The "Harness adapter map" in `specs/tools.md` is removed (OpenCode is the only consumer). `specs/mcp.md` and `specs/tools.md` are updated to mention OpenCode as the single harness.
- Source comments in `src/mcp-server.js`, `src/tools/index.js`, and `src/persona.js` are updated: the "harness-agnostic" framing is replaced with OpenCode-specific framing. The internal registry still uses `parameters` (the MCP server renames it to `inputSchema` on the wire); that boundary is unchanged.
- Test names in `test/mcp-server.test.js` are updated to drop "harness-agnostic" from descriptions. The wire-format regression test still asserts `inputSchema` is present and `parameters` is absent on the wire.
- A new workflow-convention rule is added to the root `AGENTS.md`: "OpenCode is the only harness. The MCP server, the tool manifest, and the persona are all configured for OpenCode. Other harnesses (Codebuff, Claude Desktop, custom adapters) are out of scope."
- 125/125 tests passing (`npm test`). Smoke check OK (`npm run smoke`).

What is broken / rough / missing in a way a user would notice:
- None new. The shutdown-handler/commitImprovements tension and the `send_chat` error-kind string match noted in the previous state-of-play entry are still open.

What is "there" but feels bad to use:
- The OpenCode agent file's body is a concise system prompt that points at `workspace/AGENTS.md` for the full operating manual. This is the right trade-off (avoid duplicating ~200 lines of persona instructions), but it means the agent must read `workspace/AGENTS.md` on first run to get the full picture. A future cleanup could inline the full instructions if OpenCode's context window comfortably absorbs them.

### 2026-06-13 — in-world action tools, typed NotConnectedError, single in-world voice, tests that never commit

What works:
- `src/skills/in-world.js` is a new module with nine action helpers (equipItem, dropItem, useHeldItem, readChatHistory, scanNearbyEntities, getBlockInfo, findBlock, lookAtPosition, attackEntity). Every helper returns the standard `{ ok, error?, kind? }` envelope and a `requireConnected()` guard at the top. The `hostile` and `passive` enum values on `scan_nearby_entities` classify mobs via a hardcoded `PASSIVE_MOBS` set.
- `src/tools/index.js` registers 15 new in-world tools: move_to, stop_moving, follow_player, look_at_block, look_at_position, mine_block, place_block, find_block, read_chat_history, scan_nearby_entities, get_block_info, equip_item, drop_item, use_held_item, attack_entity.
- `src/connection.js` adds a `NotConnectedError` class with a stable `kind: 'not_connected'`. `sendChat()` throws it on the not-connected path instead of returning a flat envelope. The MCP tool wrapper, the `/api/say` HTTP route, and the persona loop's error reporter all converge on `say()` in `src/skills/chat.js` as the single envelope-conversion point. `say()` re-throws unknown errors (no `kind` field) and converts typed errors.
- `src/agent.js` error reporter is wrapped in its own try/catch so a double-fault doesn't escape silently. The two events.js imports are merged.
- `src/shutdown.js` `commitImprovements({ message, cwd })` now has a JSDoc note flagging `cwd` as test-only. The `run()` helper respects the override, and the `commitImprovements is a no-op when nothing in skills/scripts changed` test now uses a throwaway git repo so it can never produce a real commit on the project repo.
- `test/shutdown.test.js`'s "shutdown disconnects and writes a session summary" test was removed because it called the real `shutdown()` against the project repo, which had been producing the `19a8c76` and `87e50db` playing-agent commits. The shutdown test surface is now hermetic: no test touches the project repo's git history.
- `test/in-world.test.js` is new, with 35 tests covering not-connected, validation, happy-path, the new hostile/passive enum mapping, and the `say()` envelope contract (not_connected, message_required, ok, re-throw of unknown errors). The `connectedBot(extra)` helper spreads `extra` so test overrides take effect.
- `workspace/skills/{combat,inventory,observation,movement,world-interaction,status,chat}.md` are updated to reference the new in-world tool names. The skills point at the canonical MCP tool names instead of the in-process skill functions.
- `specs/tools.md`, `workspace/AGENTS.md`, and `VISION.md` are updated: the tool list, the broad API table, and the in-world action section now match the registry. The `kind` table is expanded with every stable error category the new tools expose (`not_connected`, `message_required`, `item_missing`, `target_required`, `no_position`, etc.). The "why `kind` is reserved for errors" note is added.
- 122/122 tests passing (`npm test`). Smoke check OK (`npm run smoke`).

What is broken / rough / missing in a way a user would notice:
- The shutdown-handler/commitImprovements tension noted in the previous state-of-play entry is still open. `commitImprovements()` still auto-commits any uncommitted change in `workspace/skills/` and `workspace/scripts/`. The consult-before-commit flow says committed modifications require an explicit user approval in chat, so the auto-commit path is in tension with that. A follow-up should make the auto-commit path only commit files with a matching approved proposal, or surface a chat summary instead of committing.
- `PASSIVE_MOBS` is a hardcoded list of Minecraft 1.21 passive mobs. The docstring warns future contributors that it is world-version-specific, but a new Minecraft release could add a passive variant that ends up classified as hostile. Long-term: derive passivity from Mineflayer's entity registry, or at least add a test that catches the most common regressions.

What is "there" but feels bad to use:
- The `try/finally` + manual `unlinkSync` pattern in the test files is repetitive (one in `test/shutdown.test.js`, one in `test/improve.test.js`). A small `withMemoryCleanup(fn)` wrapper would collapse the boilerplate, but the explicit `trackMemory` + `unlinkSync` makes the create-and-cleanup boundary obvious at the call site, which is the higher-value readability trade-off.
- The shutdown handler still says "promote session improvements" in its commit subject. With the consult-before-commit flow, "promote" is the wrong verb for anything the user didn't approve. A future cleanup should rename the subject to "shutdown: write session summary" when the commit is empty, and "shutdown: apply approved proposals" when it isn't.
