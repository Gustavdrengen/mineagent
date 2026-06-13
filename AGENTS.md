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
│   ├── scripts/            on-demand helper scripts
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
