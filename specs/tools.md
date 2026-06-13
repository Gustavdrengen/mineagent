# MineAgent Tool Spec

This is the behavior contract for every tool the MineAgent persona exposes to its LLM harness. The shape is **harness-agnostic** by design — a thin adapter layer (not shipped in this repo) can map it to MCP `inputSchema`, OpenAI `parameters`, or any other envelope. No provider-specific fields are present in the wire format.

## Tool descriptor shape

Each tool is described by:

```ts
{
  name: string,         // unique identifier, snake_case
  description: string,  // natural language, used by the model for routing
  parameters: {         // strict JSON Schema subset (Draft 2020-12 compatible)
    type: "object",
    additionalProperties: false,
    properties: { [argName: string]: JSONSchema },
    required: string[]
  },
  execute: (args: object) => Promise<Result>
}
```

The `parameters` object is the **convergence point** across MCP, OpenAI function calling, Anthropic tool use, and Gemini function calling. The strict subset used here is:

- `type: "object"` at the root
- `properties` map of arg name → JSON Schema
- `required` array of arg names
- `additionalProperties: false` to reject hallucinated args
- per-arg `type` ∈ `"string" | "number" | "boolean" | "array" | "object"`
- per-arg `description` (required, natural language)
- per-arg `enum` (optional, on string params)
- per-arg `default` is **not** used; defaults are applied in `execute`

## Wire format vs runtime

The `execute` function is the runtime entry point. The **manifest** is the projection of the registry without `execute`. Adapters should:

1. Call `getToolManifest()` from `src/tools/index.js` to get the manifest.
2. Map each entry to the harness-specific envelope.
3. Route harness tool calls to `callTool(name, args)` in the same module.

## Harness adapter map (informational, not implemented here)

| MineAgent | OpenAI | Anthropic / MCP | Gemini |
|---|---|---|---|
| `name` | `function.name` | `name` | `name` |
| `description` | `function.description` | `description` | `description` |
| `parameters` | `function.parameters` | `input_schema` | `parameters` |
| (envelope) | `{ type: "function", function: {...} }` | `{...}` (no envelope) | `{...}` (no envelope) |

The user-facing API in MineAgent is just `getToolManifest()` and `callTool(name, args)`. Any adapter is a one-page transformation.

## Tool list

| Name | Purpose |
|---|---|
| `connect_to_server` | Open a Mineflayer connection. Returns `ok` + `kind` on failure. |
| `disconnect_from_server` | Clean shutdown of the current connection. |
| `set_username` | Override the configured username for the next connect. |
| `connection_status` | Live snapshot of the bot state. |
| `ask_user_for_server` | Get a prompt to ask the user for an IP/port. |
| `connect_to_last_known_server` | Reconnect to the server in `memories/last-server.json`. |
| `forget_last_server` | Clear the remembered server. |
| `speak` | Trigger a TTS voice event through the browser observer. |
| `shutdown` | Stop the bot, write a session summary, attempt a commit. |
| `propose_skill_change` | **Start a committable change.** Writes to `memories/proposals/`, returns a `chatPrompt` to ask the user. |
| `list_proposals` | List pending proposals in `memories/proposals/`. |
| `read_proposal` | Read a proposal's full markdown body. |
| `reject_proposal` | Delete a proposal the user has rejected. |
| `create_skill` | **Committed change.** Only call after `propose_skill_change` and explicit user approval. |
| `update_skill` | **Committed change.** Replace the body of an existing skill. Same approval rule. |
| `remove_skill` | **Committed change.** Delete a skill. Same approval rule. |
| `create_script` | **Committed change.** Write a helper script. Same approval rule. |
| `write_memory` | Write a note into `workspace/memories/` (gitignored). |
| `list_skills` | List files in `workspace/skills/`. |
| `list_scripts` | List files in `workspace/scripts/`. |
| `list_memories` | List files in `workspace/memories/`. |

## Committable-change flow

`workspace/skills/` and `workspace/scripts/` are shared state. The persona does not modify them on its own. The only path from intent to commit is:

```
1. propose_skill_change(name, action, body, kind, summary, reason)
     -> writes memories/proposals/<name>-<ts>.md
     -> returns { chatPrompt }
2. Persona asks the user in chat using the returned chatPrompt.
3a. On approval:
      create_skill | update_skill | remove_skill | create_script
3b. On rejection:
      reject_proposal(proposalId)
```

Rules:

- Every `create_*` / `update_*` / `remove_*` tool is a **committed modification**. The persona must always precede it with a `propose_skill_change` call and an explicit user approval in chat.
- The `action` parameter on `propose_skill_change` is one of `create`, `revise`, `remove`, `generalize`. The persona uses `revise` or `generalize` for maintenance updates to existing skills; the matching execute tool is `update_skill` (which overwrites the body).
- Proposals are gitignored (under `memories/`). The shutdown handler does **not** auto-promote proposals into `skills/` or `scripts/`; that path requires the execute tool after an in-session approval.
- All skills and tools must be **world-agnostic** — useful on any offline-mode Minecraft server, in any build, in any biome. Over-specific skills (e.g., "build a prismarine tower at coordinates X,Y,Z on server FOO") must be generalized or removed via the proposal flow.
- Maintenance triggers, in priority order: **staleness → over-specificity → optional tool-reference additions**. Staleness and over-specificity are always worth proposing. Tool-reference additions are a soft judgment call, not a hard rule: skills about chat tone, roleplay, etiquette, or pure context do not need tool references and the agent should skip that audit for them.

## Error kinds

Stable, defined in `src/connection.js` (`ERROR_KIND`) and the tool-level helpers.

## Result envelope

Every `execute` returns a structured object. The shape is:

```ts
{
  ok: boolean,           // true on success, false on any failure
  error?: string,        // human-readable message
  kind?: string          // stable machine-readable error category (see below)
}
```

Tool results never throw. Failures are always `{ ok: false, error, kind? }`.

### Error kinds

Stable, defined in `src/connection.js` (`ERROR_KIND`) and the tool-level helpers:

| Kind | Source | Meaning |
|---|---|---|
| `no_host` | `connect_to_server` | Host was missing or empty. |
| `already_connecting` | `connect_to_server` | A connect is already in flight. |
| `unreachable` | `connect_to_server` | DNS/routing failed (ENOTFOUND, EAI_AGAIN, EHOSTUNREACH, ENETUNREACH, or pre-spawn `end`). |
| `refused` | `connect_to_server` | ECONNREFUSED — nothing listening. |
| `timeout` | `connect_to_server` | ETIMEDOUT or ECONNRESET. |
| `auth_required` | `connect_to_server` | Kicked reason mentions online/Mojang auth. Out of scope. |
| `version_mismatch` | `connect_to_server` | Kicked reason mentions version. |
| `not_whitelisted` | `connect_to_server` | Kicked reason mentions whitelist. |
| `kicked` | `connect_to_server` | Kicked for other reasons. |
| `no_memory` | `connect_to_last_known_server` | No `memories/last-server.json` to read. |
| `unknown_tool` | `callTool` | The name passed to `callTool` is not registered. The `hint` field lists available tools. |
| `execution_error` | `callTool` | The tool's `execute` threw an exception. |

`callTool(name, args)` is the harness-facing entry point. It is the only way the harness should invoke a tool, so the unknown-tool diagnostic and exception wrapping are guaranteed.

## Self-test

`node --test test/tools.test.js` verifies:

- `getToolManifest()` returns a stable projection of the registry (no `execute`).
- Every manifest entry has `name`, `description`, and a strict `parameters` JSON Schema.
- `callTool` returns `kind: 'unknown_tool'` with a `hint` for an unregistered name.
- `callTool` returns `kind: 'execution_error'` when a tool's `execute` throws.
- All previously registered tools still work.
