# Connection Tool Spec

Behavior contract for the connection tools in `src/tools/index.js` and the underlying connection manager in `src/connection.js`. This spec is the source of truth for what each tool must do.

## State machine

`disconnected` → `connecting` → (`connected` | `error`) → `disconnected` (via `end` or `disconnect_from_server`).

`reconnecting` is reserved for a future reconnect strategy and is not currently entered by the bootstrap.

## Error kinds (stable)

Every `connectToServer` failure returns `{ ok: false, error, kind }`. The `kind` field is a stable string from `ERROR_KIND` (see `src/connection.js`):

| Kind | Trigger | Retry? |
|---|---|---|
| `no_host` | host was missing/empty | no — call `ask_user_for_server` |
| `already_connecting` | another connect in flight | no — wait for it to settle |
| `unreachable` | DNS / routing / pre-spawn `end` | yes, then ask user |
| `refused` | ECONNREFUSED | yes, after user confirms port |
| `timeout` | ETIMEDOUT / ECONNRESET | yes, with backoff |
| `auth_required` | kicked reason mentions online/Mojang auth | **no** — out of scope |
| `version_mismatch` | kicked reason mentions version | no — ask user to switch |
| `not_whitelisted` | kicked reason mentions whitelist | no — ask user to whitelist |
| `kicked` | kicked for other reasons | depends on reason |
| `unknown` | could not classify | no — surface raw error |

The agent loop should branch on `result.kind` rather than pattern-matching the `error` string. The `error` string is for human display only.

## `connect_to_server(host, port?, username?)`

- **Inputs**
  - `host` (required, string) — server hostname or IP.
  - `port` (optional, number, default 25565) — server port.
  - `username` (optional, string) — override the configured username for this connect.
- **Behavior**
  - Reject with `kind: 'no_host'` if host is missing/empty.
  - Reject with `kind: 'already_connecting'` if already `connecting` or `connected`.
  - Set state to `connecting`, then call `mineflayer.createBot({ host, port, username, auth: 'offline' })`.
  - On `spawn`, transition to `connected`, write `memories/last-server.json`, and resolve `{ ok: true, host, port, username }`.
  - On `kicked`, classify the reason into a `kind` and resolve `{ ok: false, error: 'kicked: <reason>', kind }`.
  - On `error`, classify `err.code` into a `kind` and resolve `{ ok: false, error: <message>, kind }`.
  - On `end` before spawn, resolve `{ ok: false, error: 'disconnected before spawn', kind: 'unreachable' }`.
- **Side effects**
  - On success, `writeLastServer({ host, port, username })` updates the remembered-server file.
  - On failure, `writeLastServer({ lastError })` records the structured error against the attempted host.

## `disconnect_from_server()`

- **Behavior**
  - If no active bot, set state to `disconnected` and resolve `{ ok: true, alreadyDisconnected: true }`.
  - Otherwise call `bot.quit()`, clear the bot reference, set state to `disconnected`, and resolve `{ ok: true }`.

## `set_username(username)`

- **Inputs**
  - `username` (required, string).
- **Behavior**
  - Reject empty or missing username.
  - Update `state.config.username`.

## `connection_status()`

- **Behavior**
  - Return the current snapshot of `state` minus the active bot reference.

## `ask_user_for_server()`

- **Behavior**
  - Return a prompt the calling layer can present to the user. The CLI prints it as a readline prompt; an LLM harness can present it to the user verbatim.

## `connect_to_last_known_server()`

- **Behavior**
  - Read `workspace/memories/last-server.json` and call `connect_to_server` with the remembered values.
  - If the file is missing, return `{ ok: false, error: 'no remembered server in memories/', kind: 'no_memory' }`.
  - On success or failure, update the memory file with the new attempt.

## `forget_last_server()`

- **Behavior**
  - Delete `workspace/memories/last-server.json` and resolve `{ ok: true, forgotten: true }`.

## Last-known server memory

Stored at `workspace/memories/last-server.json` (gitignored). Shape:

```json
{
  "host": "192.168.1.10",
  "port": 25565,
  "username": "MineAgent",
  "lastConnectedAt": "2026-06-13T12:34:56.000Z",
  "lastError": null
}
```

Reads and writes are best-effort; a missing or corrupt file yields `null`, not an exception. The shutdown commit does **not** commit this file (memories are gitignored).
