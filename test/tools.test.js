// Tests for the tool registry, callTool manifest, and connection
// error.kind classification. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tools,
  findTool,
  findToolsByPrefix,
  getToolManifest,
  callTool,
  buildParameters,
  PARAM,
} from '../src/tools/index.js';
import { state, STATUS, setStatus, resetRuntime } from '../src/state.js';
import { connectToServer, ERROR_KIND } from '../src/connection.js';
import {
  readLastServer,
  writeLastServer,
  clearLastServer,
} from '../src/improve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const lastServerFile = path.join(repoRoot, 'workspace', 'memories', 'last-server.json');

const REQUIRED_TOOLS = [
  'connect_to_server',
  'disconnect_from_server',
  'set_username',
  'connection_status',
  'ask_user_for_server',
  'connect_to_last_known_server',
  'forget_last_server',
];

function cleanup() {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  if (fs.existsSync(lastServerFile)) {
    fs.unlinkSync(lastServerFile);
  }
}

test('all vision-mandated connection tools are registered', () => {
  const names = tools.map((t) => t.name);
  for (const required of REQUIRED_TOOLS) {
    assert.ok(names.includes(required), `missing tool: ${required}`);
  }
});

test('every tool has a strict JSON Schema parameters object', () => {
  for (const tool of tools) {
    const p = tool.parameters;
    assert.equal(p.type, 'object', `${tool.name}: type must be "object"`);
    assert.equal(p.additionalProperties, false, `${tool.name}: additionalProperties must be false`);
    assert.equal(typeof p.properties, 'object');
    assert.ok(Array.isArray(p.required));
    for (const key of Object.keys(p.properties)) {
      const sub = p.properties[key];
      assert.ok(['string', 'number', 'boolean', 'array', 'object'].includes(sub.type),
        `${tool.name}.${key}: unsupported type ${sub.type}`);
    }
  }
});

test('getToolManifest returns a projection without execute', () => {
  const manifest = getToolManifest();
  assert.equal(manifest.length, tools.length);
  for (const entry of manifest) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.description, 'string');
    assert.equal(typeof entry.parameters, 'object');
    assert.equal(entry.execute, undefined);
  }
});

test('callTool returns kind=unknown_tool with a hint for missing tools', async () => {
  const result = await callTool('does_not_exist', {});
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unknown_tool');
  assert.ok(typeof result.hint === 'string' && result.hint.length > 0);
  assert.match(result.hint, /getToolManifest/);
});

test('callTool returns kind=execution_error when execute throws', async () => {
  // Build a one-off tool registry that always throws, then call it
  // through the public callTool surface using a temporary override.
  // We do this by mutating the `tools` array in place for the duration
  // of the test and restoring it afterwards.
  const toolsModule = await import('../src/tools/index.js');
  const original = toolsModule.tools[0];
  const originalExecute = original.execute;
  original.execute = async () => {
    throw new Error('boom');
  };
  try {
    const r = await callTool(original.name, {});
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'execution_error');
    assert.match(r.error, /boom/);
  } finally {
    original.execute = originalExecute;
  }
});

test('buildParameters assembles strict JSON Schema from PARAM helpers', () => {
  const schema = buildParameters({
    a: PARAM.string('alpha', { required: true }),
    b: PARAM.number('beta'),
    c: PARAM.string('choice', { enum: ['x', 'y'] }),
  });
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['a']);
  assert.equal(schema.properties.a.type, 'string');
  assert.equal(schema.properties.b.type, 'number');
  assert.deepEqual(schema.properties.c.enum, ['x', 'y']);
  // _required markers must not leak into the wire format.
  assert.equal(schema.properties.a._required, undefined);
});

test('connection_status returns ok=true with the live state', async () => {
  cleanup();
  const r = await callTool('connection_status', {});
  assert.equal(r.ok, true);
  assert.equal(r.status, STATUS.DISCONNECTED);
  assert.equal(r.username, state.config.username);
});

test('connect_to_server returns kind=no_host when host is empty', async () => {
  cleanup();
  // The pre-flight no_host path must NOT transition state to ERROR —
  // it is a caller-input error, not a connection failure.
  const before = state.status;
  const r = await callTool('connect_to_server', { host: '' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, ERROR_KIND.NO_HOST);
  assert.equal(state.status, before, 'no_host must not change state');
});

test('connect_to_server returns kind=already_connecting when state is connecting', async () => {
  cleanup();
  setStatus(STATUS.CONNECTING);
  try {
    const r = await callTool('connect_to_server', { host: '127.0.0.1' });
    assert.equal(r.ok, false);
    assert.equal(r.kind, ERROR_KIND.ALREADY_CONNECTING);
  } finally {
    cleanup();
  }
});

test('connect_to_last_known_server returns kind=no_memory when no memory exists', async () => {
  cleanup();
  clearLastServer();
  const r = await callTool('connect_to_last_known_server', {});
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'no_memory');
});

test('forget_last_server writes nothing and returns ok=true', async () => {
  cleanup();
  writeLastServer({ host: '1.2.3.4', port: 25565, username: 'x' });
  assert.ok(fs.existsSync(lastServerFile));
  const r = await callTool('forget_last_server', {});
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(lastServerFile), false);
});

test('writeLastServer persists a JSON file and readLastServer round-trips', () => {
  cleanup();
  const w = writeLastServer({
    host: '192.168.1.10',
    port: 25565,
    username: 'TestBot',
  });
  assert.equal(w.ok, true);
  const r = readLastServer();
  assert.equal(r.host, '192.168.1.10');
  assert.equal(r.port, 25565);
  assert.equal(r.username, 'TestBot');
  assert.ok(r.lastConnectedAt);
});

test('writeLastServer records lastError without dropping host/port/username', () => {
  cleanup();
  writeLastServer({ host: 'a', port: 1, username: 'u' });
  const w = writeLastServer({ lastError: { ok: false, kind: 'kicked' } });
  assert.equal(w.ok, true);
  const r = readLastServer();
  assert.equal(r.host, 'a');
  assert.equal(r.port, 1);
  assert.equal(r.username, 'u');
  assert.equal(r.lastError.kind, 'kicked');
});

test('writeLastServer treats empty string as no-op for host/port/username', () => {
  cleanup();
  writeLastServer({ host: 'keep-me', port: 25565, username: 'Keeper' });
  writeLastServer({ host: '', port: 0, username: '' });
  const r = readLastServer();
  assert.equal(r.host, 'keep-me');
  assert.equal(r.port, 25565);
  assert.equal(r.username, 'Keeper');
});

test('readLastServer returns null when the file is missing or corrupt', () => {
  cleanup();
  assert.equal(readLastServer(), null);
  fs.mkdirSync(path.dirname(lastServerFile), { recursive: true });
  fs.writeFileSync(lastServerFile, 'not json', 'utf8');
  assert.equal(readLastServer(), null);
  cleanup();
});

test('ask_user_for_server returns a non-empty prompt', async () => {
  const r = await callTool('ask_user_for_server', {});
  assert.equal(r.ok, true);
  assert.ok(r.prompt.length > 0);
});

test('set_username updates the configured username', async () => {
  cleanup();
  const original = state.config.username;
  try {
    const r = await callTool('set_username', { username: 'TestBot' });
    assert.equal(r.ok, true);
    assert.equal(state.config.username, 'TestBot');
  } finally {
    state.config.username = original;
    cleanup();
  }
});

test('set_username rejects empty username', async () => {
  const r = await callTool('set_username', { username: '' });
  assert.equal(r.ok, false);
});

test('ERROR_KIND is frozen and has all expected keys', () => {
  assert.equal(typeof ERROR_KIND, 'object');
  assert.ok(Object.isFrozen(ERROR_KIND));
  for (const k of [
    'UNREACHABLE',
    'REFUSED',
    'TIMEOUT',
    'AUTH_REQUIRED',
    'VERSION_MISMATCH',
    'NOT_WHITELISTED',
    'KICKED',
    'ALREADY_CONNECTING',
    'NO_HOST',
    'UNKNOWN',
  ]) {
    assert.ok(ERROR_KIND[k], `missing ERROR_KIND.${k}`);
  }
});

test('classifyKickReason maps kick reasons to stable kinds', async () => {
  // Import the internal helper through the test export.
  const { __test_classifyKickReason } = await import('../src/connection.js');
  assert.equal(
    __test_classifyKickReason('You are not on the whitelist!'),
    ERROR_KIND.NOT_WHITELISTED
  );
  assert.equal(
    __test_classifyKickReason('Outdated client!'),
    ERROR_KIND.VERSION_MISMATCH
  );
  assert.equal(
    __test_classifyKickReason('Incompatible protocol version'),
    ERROR_KIND.VERSION_MISMATCH
  );
  // A kick reason that contains the word "version" but does not match
  // the exact phrases should NOT be classified as version_mismatch.
  // This is the regression test for the broad-substring bug.
  assert.equal(
    __test_classifyKickReason('Your version of the launcher is too old'),
    ERROR_KIND.KICKED
  );
  assert.equal(
    __test_classifyKickReason('Online mode is enabled'),
    ERROR_KIND.AUTH_REQUIRED
  );
  assert.equal(
    __test_classifyKickReason('You are not premium'),
    ERROR_KIND.AUTH_REQUIRED
  );
  assert.equal(
    __test_classifyKickReason('Connection throttled'),
    ERROR_KIND.KICKED
  );
  assert.equal(__test_classifyKickReason(null), ERROR_KIND.KICKED);
  assert.equal(__test_classifyKickReason(''), ERROR_KIND.KICKED);
});

test('classifySocketError maps Node err codes to stable kinds', async () => {
  const { __test_classifySocketError } = await import('../src/connection.js');
  assert.equal(
    __test_classifySocketError({ code: 'ENOTFOUND' }),
    ERROR_KIND.UNREACHABLE
  );
  assert.equal(
    __test_classifySocketError({ code: 'EAI_AGAIN' }),
    ERROR_KIND.UNREACHABLE
  );
  assert.equal(
    __test_classifySocketError({ code: 'ECONNREFUSED' }),
    ERROR_KIND.REFUSED
  );
  assert.equal(
    __test_classifySocketError({ code: 'ETIMEDOUT' }),
    ERROR_KIND.TIMEOUT
  );
  assert.equal(
    __test_classifySocketError({ code: 'ECONNRESET' }),
    ERROR_KIND.TIMEOUT
  );
  assert.equal(
    __test_classifySocketError({ code: 'WAT' }),
    ERROR_KIND.UNKNOWN
  );
  assert.equal(__test_classifySocketError(null), ERROR_KIND.UNKNOWN);
});

test('cleanup', () => {
  cleanup();
});
