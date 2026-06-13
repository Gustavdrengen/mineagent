// Persona entry point for MineAgent.
//
// This is the single, programmatic way to boot the in-world persona.
// A parent agent, a test harness, or the CLI can call `startPersona` to
// get a fully wired MineAgent: tool manifest exposed, last-known
// server offered, connection attempted, chat listener attached, and the
// observer server started if requested.
//
// The function is intentionally synchronous in its setup and returns a
// structured result so the caller can decide what to do next (run a
// goal, dispatch chat, shut down). The CLI in `src/index.js` is a thin
// wrapper around this function.
//
// **Decision:** Add `startPersona()` as a single entry point. **Tier:**
// T1. **Evidence:** Original feedback — the persona had no honest
// programmatic way to come up; the CLI was the only way and it mixed
// readline with agent wiring. **Trade-off:** Slight overlap with
// `src/index.js`; the CLI is now a thin shell over this function.

import { connectToServer, disconnectFromServer, getStatus, ERROR_KIND } from './connection.js';
import { state, snapshot } from './state.js';
import { attachChatListener, runGoal, dispatch } from './agent.js';
import { getToolManifest, callTool } from './tools/index.js';
import { readLastServer } from './improve.js';
import { emit } from './events.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// Resolve the host/port/username triple MineAgent should try first.
// Priority: explicit args > remembered server > prompt. The persona
// never silently picks a random server; if nothing is known, it asks.
export async function resolveServer({
  host,
  port,
  username,
  prompt = false,
  promptFn = defaultPrompt,
} = {}) {
  if (host) {
    return {
      host,
      port: port ?? 25565,
      username: username ?? state.config.username,
      source: 'argument',
    };
  }
  const remembered = readLastServer();
  if (remembered && remembered.host) {
    return {
      host: remembered.host,
      port: remembered.port ?? 25565,
      username: username ?? remembered.username ?? state.config.username,
      source: 'memory',
    };
  }
  if (prompt) {
    const asked = await promptFn();
    if (asked && asked.host) {
      return {
        host: asked.host,
        port: asked.port ?? 25565,
        username: username ?? state.config.username,
        source: 'prompt',
      };
    }
  }
  return { host: null, source: 'none' };
}

async function defaultPrompt() {
  try {
    const rl = readline.createInterface({ input, output });
    const host = (await rl.question('Server host (IP or hostname): ')).trim();
    const portRaw = (await rl.question('Server port [25565]: ')).trim();
    rl.close();
    return { host: host || null, port: portRaw ? Number(portRaw) : 25565 };
  } catch {
    return { host: null };
  }
}

// Boot the in-world persona. Returns:
//   { ok, status, host, port, username, source, error?, kind?, manifest }
//
// `goal`, if provided, is dispatched through runGoal after the connect
// attempt succeeds. If the connect fails, the goal is not run and the
// error is returned.
export async function startPersona({
  host,
  port,
  username,
  goal,
  prompt = false,
  attachChat = true,
  startObserver = false,
  // When true, do not throw on a failed connection; just return the
  // structured result. Default: true (matches the persona's "ask,
  // retry, give up cleanly" contract from VISION.md).
  lenient = true,
  promptFn,
  observerStart,
} = {}) {
  // Always expose the tool manifest and tool dispatcher up front, even
  // before the connect attempt. The persona can introspect its own
  // capabilities via the manifest without needing a connection.
  const manifest = getToolManifest();

  const resolved = await resolveServer({
    host,
    port,
    username,
    prompt,
    promptFn,
  });

  if (!resolved.host) {
    return {
      ok: false,
      status: state.status,
      manifest,
      error:
        'no server known — pass `host`, enable `prompt`, or call ' +
        'connect_to_last_known_server after a previous successful ' +
        'connect.',
      kind: 'no_server',
    };
  }

  if (resolved.username && resolved.username !== state.config.username) {
    state.config.username = resolved.username;
  }
  if (resolved.port) {
    state.config.port = resolved.port;
  }

  const result = await connectToServer({
    host: resolved.host,
    port: resolved.port,
    username: resolved.username,
  });

  // Wire the chat listener on success so in-game chat can drive the
  // agent. On failure we still return a usable manifest so the caller
  // can attempt recovery.
  let detachChat = () => {};
  if (attachChat) {
    detachChat = attachChatListener();
  }

  let observerHandle = null;
  if (startObserver && typeof observerStart === 'function') {
    try {
      observerHandle = await observerStart();
    } catch (err) {
      observerHandle = { ok: false, error: err.message };
    }
  }

  let goalResult = null;
  if (goal && result.ok) {
    goalResult = await runGoal(goal);
  }

  emit('persona', {
    status: result.ok ? 'ready' : 'error',
    source: resolved.source,
    result,
  });

  return {
    ok: result.ok,
    status: state.status,
    host: resolved.host,
    port: resolved.port,
    username: resolved.username,
    source: resolved.source,
    error: result.error,
    kind: result.kind,
    manifest,
    goalResult,
    observer: observerHandle,
    detach: () => {
      detachChat();
    },
    // Surface the harness-agnostic call entry point for callers that
    // want to invoke tools directly without going through runGoal.
    callTool,
    shutdown: disconnectFromServer,
  };
}

// Public surface: the manifest, the dispatcher, and the persona
// entry point. The full `tools` array (with `execute` functions) is
// intentionally NOT re-exported — harnesses should consume the
// manifest and route tool calls through `callTool` so that the
// unknown-tool diagnostic and exception wrapping are guaranteed.
//
// Note on MCP vs in-process callTool: the persona's JavaScript loop
// imports callTool directly from `./tools/index.js`. This is
// deliberate — the in-process call is the runtime path, and forcing
// the persona to round-trip through the MCP server's stdio JSON-RPC
// would add a parse/encode step with no benefit. The MCP server
// (src/mcp-server.js) is the *public* surface for any external LLM
// harness (Codebuff, Claude Desktop, a custom agent, the CLI in
// --mcp mode). Both paths wrap the same `tools` array.
export {
  callTool,
  getToolManifest,
  dispatch,
  runGoal,
  getStatus,
  snapshot,
  ERROR_KIND,
};
