# MineAgent MCP Server Spec

The behavior contract for the stdio JSON-RPC 2.0 server at `src/mcp-server.js`. The server is the single tool source for the MineAgent persona and for any MCP client (Codebuff, Claude Desktop, a custom harness, the test runner, the CLI). The persona never calls into `src/` directly.

## Transport

- **Wire format:** line-delimited JSON-RPC 2.0 over stdio.
- **Input:** one JSON object per line on stdin.
- **Output:** one JSON object per line on stdout. Diagnostics (if any) go to stderr.
- **Encoding:** UTF-8.

## Methods

The server implements the subset of the Model Context Protocol 2024-11-05 spec that MineAgent needs:

| Method | Direction | Purpose |
|---|---|---|
| `initialize` | request | Handshake. Returns protocol version, capabilities, and server info. |
| `ping` | request | Liveness check. Returns `{}`. |
| `tools/list` | request | Returns the harness-agnostic manifest. |
| `tools/call` | request | Invokes a tool by name with arguments. |
| `notifications/initialized` | notification | Client signals it has consumed the initialize response. No reply. |
| `notifications/cancelled` | notification | Client cancels an in-flight request. Acknowledged but produces no reply. |
| `notifications/progress` | notification | Optional progress signal. Acknowledged. |

Requests without an `id` are treated as notifications and produce no response.

## Tool manifest

`tools/list` returns `{ tools: [...] }`, where each entry is the same shape `getToolManifest()` produces in `src/tools/index.js`:

```ts
{
  name: string,
  description: string,
  parameters: {  // strict JSON Schema subset
    type: "object",
    additionalProperties: false,
    properties: { [argName: string]: JSONSchema },
    required: string[]
  }
}
```

The `execute` function is **not** included; the manifest is the wire-safe projection.

## Tool call

`tools/call` takes `{ name: string, arguments: object }` and returns:

```ts
{
  content: [{ type: "text", text: string }],  // text is the JSON-stringified tool result
  isError: boolean                              // true when the tool's ok was false
}
```

The full result envelope (including `error`, `kind`, `hint`) is preserved as JSON in the `text` field. The `isError` flag is a quick top-level signal for clients that do not want to parse the inner JSON.

When `name` is not registered, the response is shaped the same way but the `text` field contains `{ ok: false, error: "unknown tool: <name>", kind: "unknown_tool", hint: "..." }` — the same diagnostic the in-process `callTool` returns.

## Lifecycle

The server enforces "one instance at a time" on startup:

1. Read the pidfile at `$MINEAGENT_MCP_PIDFILE` (default `.runtime/mcp-server.pid`).
2. If the file exists and the recorded PID is alive, send `SIGTERM`.
3. Poll for up to 2 seconds (every 100ms) for the previous process to exit. If it is still alive, send `SIGKILL`.
4. Remove the pidfile if it is stale.
5. Write the current PID to the pidfile.
6. Install cleanup hooks for `SIGINT`, `SIGTERM`, `exit`, `uncaughtException`, and `unhandledRejection` so the pidfile is removed on shutdown.

This makes the start script (`workspace/start-mcp.sh`) idempotent: running it twice in a row is safe; the first instance is shut down before the second starts.

### Stale pidfiles

The pidfile is removed on every graceful signal. A `kill -9` on the server (or any other untrapped kill) will leave a stale pidfile behind; the next start detects this via `isAlive()` (which signals 0 to the recorded PID), treats the previous owner as gone, overwrites the pidfile with its own PID, and proceeds. There is no lock daemon — the pidfile is a hint, not a guarantee, and the next-start-overwrite behavior is intentional.

## Errors

JSON-RPC 2.0 standard error codes are used:

| Code | Name | Meaning |
|---|---|---|
| `-32700` | `ParseError` | The line was not valid JSON. |
| `-32600` | `InvalidRequest` | The object was missing `jsonrpc`, `method`, or was structurally wrong. |
| `-32601` | `MethodNotFound` | The method is not implemented. |
| `-32602` | `InvalidParams` | The method was found but its params are wrong (e.g., `tools/call` with no `name`). |
| `-32603` | `InternalError` | The handler threw. |

Errors are written as JSON-RPC error responses. The original request's `id` is preserved when present.

## Server identity

`initialize` returns:

```ts
{
  protocolVersion: "2024-11-05",
  capabilities: { tools: { listChanged: false } },
  serverInfo: { name: "mineagent", version: "0.1.0" }
}
```

`listChanged: false` because the tool palette is static for the lifetime of the process. If a future feature requires dynamic manifests, flip this to `true` and emit `notifications/tools/list_changed` when the manifest changes.

## Self-test

`node --test test/mcp-server.test.js` verifies:

- The server starts, writes its pidfile, and shuts down cleanly.
- `initialize` returns the expected `serverInfo`, `capabilities`, and `protocolVersion`.
- `tools/list` returns the same manifest `getToolManifest()` returns.
- `tools/call` against a registered tool (e.g., `list_memories`) returns `{ ok: true, ... }`.
- `tools/call` against an unregistered tool returns `kind: "unknown_tool"` with a `hint`.
- Two servers started with the same pidfile shut the first one down before the second starts (the first PID is no longer alive, the second PID is the new owner of the pidfile).
- The pidfile is removed on `SIGTERM`.
- `startMcpServer` is exported and can be driven in-process for unit tests (no real stdio required).
