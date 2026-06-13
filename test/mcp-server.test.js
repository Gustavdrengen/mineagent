// Tests for the MineAgent MCP server.
//
// The MCP server is a stdio JSON-RPC 2.0 process. Tests spawn it as a
// child process for the integration checks (real wire format, real
// process lifecycle) and use the in-process `startMcpServer` helper for
// the lifecycle / pidfile checks that need fine control over streams.
//
// Every test wraps its body in try/finally so that listeners, the
// in-process Readable, the pidfile, and any spawned child are cleaned
// up even when an assertion fails. A leaked handle keeps the test
// runner alive until its hard timeout, which masks real test failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Writable, Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const serverPath = join(projectRoot, 'src', 'mcp-server.js');

function writeRequest(stream, id, method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
  // `input` is a Readable in the in-process tests; data is fed via
  // push(). The real subprocess test uses child.stdin.write directly.
  stream.push(msg + '\n');
}

function makeBufferedWritable() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  stream.getBuffered = () => Buffer.concat(chunks).toString('utf8');
  return stream;
}

function makeLineReadable() {
  // Minimal Readable that the in-process startMcpServer can listen on.
  // Data is fed via stream.push() in the tests. Tests must call
  // stdin.destroy() in a finally block to release the handle.
  return new Readable({ read() {} });
}

function parseLines(buffer) {
  return buffer
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function findResponseById(messages, id) {
  return messages.find((m) => m.id === id) || null;
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

async function settle() {
  // A few microtask + macrotask ticks so any fire-and-forget
  // dispatchLine promises inside startMcpServer have a chance to
  // resolve and write their response.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

test('startMcpServer writes a pidfile and removes it on stop', async () => {
  const dir = makeTempDir('mineagent-mcp-pid-');
  const pidfile = join(dir, 'pid');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile,
    });
    assert.equal(handle.pid, process.pid);
    assert.equal(handle.pidfile, pidfile, 'handle should report the pidfile it used');
    assert.equal(existsSync(pidfile), true, 'pidfile should exist after start');
    handle.stop();
    assert.equal(existsSync(pidfile), false, 'pidfile should be removed on stop');
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initialize returns protocolVersion, capabilities, and serverInfo', async () => {
  const dir = makeTempDir('mineagent-mcp-init-');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: join(dir, 'pid'),
    });
    writeRequest(stdin, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    await settle();
    const lines = parseLines(stdout.getBuffered());
    const response = findResponseById(lines, 1);
    assert.ok(response, 'initialize should produce a response');
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.result.protocolVersion, '2024-11-05');
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
    assert.equal(response.result.serverInfo.name, 'mineagent');
    assert.ok(response.result.serverInfo.version, 'version should be present');
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/list returns the harness-agnostic manifest without execute', async () => {
  const dir = makeTempDir('mineagent-mcp-list-');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: join(dir, 'pid'),
    });
    writeRequest(stdin, 2, 'tools/list');
    await settle();
    const response = findResponseById(parseLines(stdout.getBuffered()), 2);
    assert.ok(response, 'tools/list should respond');
    assert.ok(Array.isArray(response.result.tools), 'tools should be an array');
    assert.ok(response.result.tools.length > 0, 'manifest should be non-empty');
    for (const tool of response.result.tools) {
      assert.equal(typeof tool.name, 'string');
      assert.equal(typeof tool.description, 'string');
      // MCP wire format (2024-11-05) names the argument schema
      // `inputSchema` (camelCase). The internal registry calls it
      // `parameters`; the MCP server is the adapter that does the
      // rename on the way out.
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.execute, undefined, 'execute must not leak through the wire');
    }
    const names = response.result.tools.map((t) => t.name);
    for (const expected of [
      'connect_to_server',
      'send_chat',
      'read_skill',
      'read_script',
      'read_memory',
      'propose_skill_change',
    ]) {
      assert.ok(names.includes(expected), `manifest should include ${expected}`);
    }
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/list manifests conform to the MCP 2024-11-05 wire format', async () => {
  // Regression test for the bug where the manifest used `parameters`
  // (the harness-agnostic name) instead of `inputSchema` (the MCP
  // spec field name). MCP clients validate the response with a strict
  // Zod schema and reject the response when `inputSchema` is missing
  // or not an object.
  const dir = makeTempDir('mineagent-mcp-wireshape-');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: join(dir, 'pid'),
    });
    writeRequest(stdin, 7, 'tools/list');
    await settle();
    const response = findResponseById(parseLines(stdout.getBuffered()), 7);
    assert.ok(response, 'tools/list should respond');
    assert.ok(Array.isArray(response.result.tools), 'tools should be an array');
    assert.ok(response.result.tools.length > 0, 'manifest should be non-empty');

    // Re-parse the result as a fresh JSON value to make sure every
    // field round-trips through the wire as a real object (not a
    // function or undefined, which would survive an in-process
    // assertion but fail when an MCP client validates the response).
    const rehydrated = JSON.parse(JSON.stringify(response.result));
    for (const tool of rehydrated.tools) {
      // The MCP spec field is `inputSchema` (camelCase). It must be
      // present and a real JSON Schema object — clients reject the
      // whole manifest when this is missing or the wrong type.
      assert.equal(
        typeof tool.inputSchema,
        'object',
        `${tool.name}: inputSchema must be an object per MCP 2024-11-05`
      );
      assert.notEqual(tool.inputSchema, null, `${tool.name}: inputSchema must not be null`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema.type must be "object"`);
      assert.equal(
        tool.inputSchema.additionalProperties,
        false,
        `${tool.name}: inputSchema.additionalProperties must be false`
      );
      assert.equal(
        typeof tool.inputSchema.properties,
        'object',
        `${tool.name}: inputSchema.properties must be an object`
      );
      assert.ok(
        Array.isArray(tool.inputSchema.required),
        `${tool.name}: inputSchema.required must be an array`
      );

      // The old `parameters` field must NOT appear on the wire.
      // Internal callers continue to use `parameters`; the rename is
      // a wire-format concern, not a registry rename.
      assert.equal(
        tool.parameters,
        undefined,
        `${tool.name}: the harness-agnostic \`parameters\` field must not appear on the MCP wire format`
      );
    }
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/call against a registered tool returns its structured result', async () => {
  const dir = makeTempDir('mineagent-mcp-call-');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: join(dir, 'pid'),
    });
    writeRequest(stdin, 3, 'tools/call', { name: 'list_memories', arguments: {} });
    await settle();
    const response = findResponseById(parseLines(stdout.getBuffered()), 3);
    assert.ok(response, 'tools/call should respond');
    assert.equal(response.result.isError, false);
    const parsed = JSON.parse(response.result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.memories));
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/call against an unregistered tool returns kind=unknown_tool with a hint', async () => {
  const dir = makeTempDir('mineagent-mcp-unknown-');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: join(dir, 'pid'),
    });
    writeRequest(stdin, 4, 'tools/call', {
      name: 'not_a_real_tool',
      arguments: { foo: 'bar' },
    });
    await settle();
    const response = findResponseById(parseLines(stdout.getBuffered()), 4);
    assert.ok(response, 'tools/call should respond');
    assert.equal(response.result.isError, true);
    const parsed = JSON.parse(response.result.content[0].text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.kind, 'unknown_tool');
    assert.ok(typeof parsed.hint === 'string' && parsed.hint.length > 0);
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a method-not-found call returns JSON-RPC error -32601', async () => {
  const dir = makeTempDir('mineagent-mcp-mnf-');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: join(dir, 'pid'),
    });
    writeRequest(stdin, 5, 'mcp/no/such/method', {});
    await settle();
    const response = findResponseById(parseLines(stdout.getBuffered()), 5);
    assert.ok(response, 'should respond');
    assert.equal(response.error.code, -32601);
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a notifications/* method is acknowledged without producing a response', async () => {
  const dir = makeTempDir('mineagent-mcp-notif-');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: join(dir, 'pid'),
    });
    writeRequest(stdin, undefined, 'notifications/initialized', {});
    await settle();
    const lines = parseLines(stdout.getBuffered());
    assert.equal(lines.length, 0, 'notifications should not produce responses');
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed JSON line produces a JSON-RPC parse error', async () => {
  const dir = makeTempDir('mineagent-mcp-parse-');
  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: join(dir, 'pid'),
    });
    stdin.push('this is not json\n');
    await settle();
    const lines = parseLines(stdout.getBuffered());
    const errorResponse = lines.find((m) => m.error && m.error.code === -32700);
    assert.ok(errorResponse, 'should produce a parse error');
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shutting down a previous instance: PID-based single-instance lifecycle', async () => {
  const dir = makeTempDir('mineagent-mcp-pid-lifecycle-');
  const pidfile = join(dir, 'pid');

  // First "server": spawn a long-lived child that just sleeps. We
  // pretend it's an MCP server by writing its PID to the pidfile and
  // checking that a second startMcpServer with the same pidfile will
  // kill it.
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(pidfile, String(sleeper.pid), 'utf8');

  const { startMcpServer } = await import(pathToFileURL(serverPath).href);
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    // Sanity check: the sleeper is alive and the pidfile points to it.
    assert.equal(isProcessAlive(sleeper.pid), true, 'sleeper should be alive');
    assert.equal(readFileSync(pidfile, 'utf8').trim(), String(sleeper.pid));

    // Start a second "server" that uses the same pidfile. It will read
    // the pidfile, SIGTERM the sleeper, and write its own PID.
    handle = await startMcpServer({
      shutdownExisting: true,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile,
    });

    // Give the SIGTERM up to 1.5s to land.
    const waitDeadline = Date.now() + 1500;
    while (Date.now() < waitDeadline && isProcessAlive(sleeper.pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(isProcessAlive(sleeper.pid), false, 'sleeper should have been killed');

    // The second server now owns the pidfile with its own PID.
    const recorded = Number.parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
    assert.equal(recorded, handle.pid, 'pidfile should now point at the new server');
  } finally {
    try { handle?.stop(); } catch { /* ignore */ }
    try { stdin.destroy(); } catch { /* ignore */ }
    if (isProcessAlive(sleeper.pid)) {
      try { process.kill(sleeper.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real subprocess: startMcpServer over stdio, initialize + ping, pidfile cleanup on SIGTERM', async () => {
  // This test spawns the real CLI entry (`node src/mcp-server.js`)
  // with a custom pidfile, sends `initialize` + `ping`, verifies the
  // responses come back as proper JSON-RPC 2.0 messages, confirms the
  // subprocess wrote its own pidfile, and then sends SIGTERM and
  // verifies the pidfile is removed.
  const dir = makeTempDir('mineagent-mcp-subproc-');
  const pidfile = join(dir, 'pid');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MINEAGENT_MCP_PIDFILE: pidfile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  let sentSigterm = false;
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'subproc-test', version: '0.0.0' },
        },
      }) + '\n'
    );
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');

    // Wait up to 3s for both responses.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const lines = stdoutBuf
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      if (lines.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const lines = stdoutBuf
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const init = lines.find((m) => m.id === 1);
    const ping = lines.find((m) => m.id === 2);
    assert.ok(init, 'subprocess should respond to initialize');
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'mineagent');
    assert.ok(ping, 'subprocess should respond to ping');
    assert.deepEqual(ping.result, {});

    // The subprocess wrote its own pidfile.
    assert.equal(existsSync(pidfile), true, 'subprocess should have written the pidfile');

    // Stderr may contain unrelated deprecation warnings from
    // transitive dependencies (e.g. Node 22's punycode warning, which
    // spans multiple lines and includes a "(Use `node --trace-
    // deprecation ...` to show where the warning was created)"
    // hint). The server itself should not have written anything to
    // stderr on a clean boot, so filter out anything that smells
    // like a deprecation notice and assert on the remainder.
    const stripped = stderrBuf
      .split('\n')
      .filter((line) => !/DeprecationWarning/i.test(line))
      .filter((line) => !/trace-deprecation/i.test(line))
      .filter((line) => !/Use `node --trace/i.test(line))
      .filter((line) => line.trim().length > 0)
      .join('\n');
    assert.equal(stripped, '', `unexpected stderr on boot: ${stripped}`);

    child.kill('SIGTERM');
    sentSigterm = true;
    await exited;
    // After SIGTERM the pidfile should be removed.
    assert.equal(existsSync(pidfile), false, 'pidfile should be cleaned up on SIGTERM');
  } finally {
    if (!sentSigterm) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      try { await exited; } catch { /* ignore */ }
    }
    try { child.stdin?.end(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
