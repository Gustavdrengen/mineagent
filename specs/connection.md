# Connection Tool Spec

Behavior contract for the five connection tools in `src/tools/index.js`. This spec is the source of truth for what each tool must do.

## `connect_to_server(host, port?, username?)`

- **Inputs**
  - `host` (required, string) — server hostname or IP.
  - `port` (optional, number, default 25565) — server port.
  - `username` (optional, string) — override the configured username for this connect.
- **Behavior**
  - Reject if already `connecting` or `connected`.
  - Set state to `connecting`, then call `mineflayer.createBot({ host, port, username, auth: 'offline' })`.
  - On `spawn`, transition to `connected` and resolve `{ ok: true, host, port, username }`.
  - On `kicked`, transition to `error` and resolve `{ ok: false, error: 'kicked: <reason>' }`.
  - On `error`, transition to `error` and resolve `{ ok: false, error: <message> }`.
  - On `end`, transition to `disconnected` (unless already `error`).
- **Output** — `{ ok, host?, port?, username?, error? }`.

## `disconnect_from_server()`

- **Behavior**
  - If no active bot, set state to `disconnected` and resolve `{ ok: true, alreadyDisconnected: true }`.
  - Otherwise call `bot.quit()`, clear the bot reference, set state to `disconnected`, and resolve `{ ok: true }`.
- **Output** — `{ ok, alreadyDisconnected?, error? }`.

## `set_username(username)`

- **Inputs**
  - `username` (required, string).
- **Behavior**
  - Reject empty or missing username.
  - Update `state.config.username`.
- **Output** — `{ ok, username, error? }`.

## `connection_status()`

- **Behavior**
  - Return the current snapshot of `state` minus the active bot reference.
- **Output** — `{ ok: true, status, host, port, username, lastError }`.

## `ask_user_for_server()`

- **Behavior**
  - Return a prompt the calling layer can present to the user. The bootstrap returns a static prompt string; a later commit wires this into the interactive agent loop.
- **Output** — `{ ok: true, prompt }`.

## State machine

`disconnected` → `connecting` → (`connected` | `error`) → `disconnected` (via `end` or `disconnect_from_server`).

`reconnecting` is reserved for a future reconnect strategy and is not currently entered by the bootstrap.

## Errors

All tools return `{ ok: false, error }` on failure. They do not throw. The caller is responsible for surfacing the error to the user.
