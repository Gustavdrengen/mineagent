// MineAgent MCP server.
//
// A stdio JSON-RPC 2.0 server that exposes MineAgent's tool palette to
// OpenCode (the single LLM harness that drives the agent) and to the
// test runner. The protocol is the standard Model Context Protocol
// 2024-11-05 surface; the wire format is line-delimited JSON over
// stdin/stdout.
//
// Methods implemented:
//
//   initialize                  -> handshake, returns serverInfo + capabilities
//   tools/list                  -> returns the tool manifest (MCP wire format)
//   tools/call                  -> invokes a tool by name with arguments
//   notifications/initialized   -> acknowledged but produces no response
//   notifications/cancelled     -> acknowledged but produces no response
//   ping                        -> returns {} (kept for spec compatibility)
//
// Lifecycle:
//
//   1. On startup, read MINEAGENT_MCP_PIDFILE (default
//      .runtime/mcp-server.pid). If the file exists and the recorded
//      process is alive, send SIGTERM and wait up to 2s for it to exit,
//      then SIGKILL if it is still alive. This is the "one server at a
//      time" guarantee the MCP config relies on.
//
//   2. Write the current PID to the pidfile. Register a cleanup hook
//      that removes the pidfile on SIGINT, SIGTERM, and uncaught
//      exceptions.
//
//   3. Read JSON-RPC requests from stdin line by line. Each line is
//      parsed as a JSON object; malformed lines are answered with a
//      JSON-RPC parse error. Concurrent requests are dispatched in
//      parallel; responses are written to stdout in completion order.
//
// **Decision:** stdio JSON-RPC over stdio. **Tier:** T1.
// **Evidence:** The MCP spec's primary transport is stdio JSON-RPC;
// OpenCode speaks it natively. **Trade-off:** No multi-client support —
// only one driver can be attached to the bot at a time. This is fine
// for the MineAgent use case (one bot, one OpenCode session).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getToolManifest, callTool } from './tools/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'mineagent', version: '0.1.0' };
const SERVER_CAPABILITIES = { tools: { listChanged: false } };

function resolvePidfile(override) {
  if (override) return path.resolve(projectRoot, override);
  if (process.env.MINEAGENT_MCP_PIDFILE) {
    return path.resolve(projectRoot, process.env.MINEAGENT_MCP_PIDFILE);
  }
  return path.join(projectRoot, '.runtime', 'mcp-server.pid');
}

// --- Single-instance lifecycle -----------------------------------------

function readPidfile(pidfile) {
  try {
    const text = fs.readFileSync(pidfile, 'utf8');
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks for existence; it does not actually deliver a
    // signal. Throws ESRCH if the process is gone, EPERM if we cannot
    // signal it (but it still exists). Either way, the PID is occupied.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

function waitForExit(pid, timeoutMs = 2000, pollMs = 100) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (!isAlive(pid)) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

async function shutdownExistingInstance(pidfile) {
  const existing = readPidfile(pidfile);
  if (!existing || !isAlive(existing)) {
    if (existing) {
      // Stale pidfile from a dead process; clean it up.
      try {
        fs.unlinkSync(pidfile);
      } catch {
        // ignore
      }
    }
    return { ok: true, replaced: null };
  }
  try {
    process.kill(existing, 'SIGTERM');
  } catch (err) {
    return { ok: true, replaced: existing, note: `could not SIGTERM pid ${existing}: ${err.message}` };
  }
  const exited = await waitForExit(existing, 2000);
  if (!exited) {
    try {
      process.kill(existing, 'SIGKILL');
    } catch {
      // ignore
    }
  }
  try {
    fs.unlinkSync(pidfile);
  } catch {
    // ignore
  }
  return { ok: true, replaced: existing };
}

function writePidfile(pidfile) {
  fs.mkdirSync(path.dirname(pidfile), { recursive: true });
  fs.writeFileSync(pidfile, String(process.pid), 'utf8');
}

let pidfileCleanupInstalled = false;
function installPidfileCleanup(pidfile) {
  if (pidfileCleanupInstalled) return;
  pidfileCleanupInstalled = true;
  const cleanup = () => {
    try {
      const recorded = readPidfile(pidfile);
      if (recorded === process.pid) {
        fs.unlinkSync(pidfile);
      }
    } catch {
      // ignore
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', cleanup);
  process.on('uncaughtException', (err) => {
    process.stderr.write(`uncaughtException: ${err && err.stack ? err.stack : err}\n`);
    cleanup();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}\n`);
    cleanup();
    process.exit(1);
  });
}

// --- JSON-RPC plumbing --------------------------------------------------

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message, data) {
  const err = { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

const JSONRPC_ERROR = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
};

function writeMessage(msg, output = process.stdout) {
  output.write(JSON.stringify(msg) + '\n');
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });

    case 'ping':
      return makeResponse(id, {});

    case 'tools/list': {
      // The MCP 2024-11-05 wire format names the argument schema
      // `inputSchema` (camelCase). The internal registry in
      // `src/tools/index.js` calls it `parameters` — that is the
      // internal name. The MCP server is the adapter that does the
      // rename on the way out so the response validates against a
      // strict MCP client schema.
      //
      // **Decision:** Rename `parameters` -> `inputSchema` at the
      // MCP boundary, not in the registry. **Tier:** T1.
      // **Evidence:** The MCP spec (2024-11-05) defines
      // `inputSchema` as the field name on the tool descriptor.
      // OpenCode validates the response with a strict schema and
      // rejects the whole manifest when this is missing or the
      // wrong type. **Trade-off:** Internal callers of
      // `getToolManifest()` still see `parameters`; the rename is a
      // wire-format concern, not a registry rename.
      const tools = getToolManifest().map(({ name, description, parameters }) => ({
        name,
        description,
        inputSchema: parameters,
      }));
      return makeResponse(id, { tools });
    }

    case 'tools/call': {
      if (!params || typeof params !== 'object') {
        return makeError(id, JSONRPC_ERROR.InvalidParams, 'params must be an object');
      }
      const { name, arguments: args } = params;
      if (typeof name !== 'string' || name.length === 0) {
        return makeError(id, JSONRPC_ERROR.InvalidParams, 'tools/call requires a non-empty `name`');
      }
      let result;
      try {
        result = await callTool(name, args || {});
      } catch (err) {
        return makeResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message, kind: 'execution_error' }) }],
          isError: true,
        });
      }
      const isError = result && result.ok === false;
      return makeResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError,
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      // Client-to-server notifications. Acknowledge by returning
      // nothing — these are notifications, not requests, and have no id.
      return null;

    default:
      return makeError(id, JSONRPC_ERROR.MethodNotFound, `method not found: ${method}`);
  }
}

async function dispatchLine(line, output = process.stdout) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    writeMessage(makeError(null, JSONRPC_ERROR.ParseError, `parse error: ${err.message}`), output);
    return;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    writeMessage(makeError(null, JSONRPC_ERROR.InvalidRequest, 'request must be a JSON object'), output);
    return;
  }
  if (parsed.jsonrpc !== '2.0') {
    writeMessage(makeError(parsed.id ?? null, JSONRPC_ERROR.InvalidRequest, 'jsonrpc must be "2.0"'), output);
    return;
  }
  if (typeof parsed.method !== 'string' || parsed.method.length === 0) {
    writeMessage(makeError(parsed.id ?? null, JSONRPC_ERROR.InvalidRequest, 'method is required'), output);
    return;
  }
  // Notifications have no id; do not reply.
  const isNotification = parsed.id === undefined || parsed.id === null;
  try {
    const response = await handleRequest(parsed);
    if (response != null && !isNotification) {
      writeMessage(response, output);
    }
  } catch (err) {
    if (!isNotification) {
      writeMessage(makeError(parsed.id, JSONRPC_ERROR.InternalError, err && err.message ? err.message : String(err)), output);
    }
  }
}

// --- Bootstrap ----------------------------------------------------------

export async function startMcpServer({
  shutdownExisting = true,
  installCleanup = true,
  input = process.stdin,
  output = process.stdout,
  logger = null,
  pidfile: pidfileOverride = null,
} = {}) {
  const pidfile = resolvePidfile(pidfileOverride);
  if (shutdownExisting) {
    const replaced = await shutdownExistingInstance(pidfile);
    if (logger && replaced.replaced) {
      logger(`replaced existing MCP server pid ${replaced.replaced}`);
    }
  }
  writePidfile(pidfile);
  if (installCleanup) {
    installPidfileCleanup(pidfile);
  }

  // Manual line splitter that works on any readable stream. The default
  // path uses stdin; tests can pass in a custom stream. `output` is
  // captured by closure so the dispatcher writes to the test's
  // buffered Writable (or process.stdout for the CLI path).
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      // Fire and forget; handleRequest is self-contained.
      dispatchLine(line, output);
    }
  };
  const onEnd = () => {
    if (buffer.trim().length > 0) {
      dispatchLine(buffer, output);
      buffer = '';
    }
  };
  input.on('data', onData);
  input.on('end', onEnd);

  return {
    pidfile,
    pid: process.pid,
    stop: () => {
      input.off('data', onData);
      input.off('end', onEnd);
      try {
        const recorded = readPidfile(pidfile);
        if (recorded === process.pid) {
          fs.unlinkSync(pidfile);
        }
      } catch {
        // ignore
      }
    },
  };
}

// CLI entry: `node src/mcp-server.js` boots the server. The function
// above is also exported so tests can drive it in-process.
const cliScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isCli = cliScriptPath !== null && cliScriptPath === fileURLToPath(import.meta.url);
if (isCli) {
  startMcpServer().catch((err) => {
    process.stderr.write(`mcp server failed to start: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
