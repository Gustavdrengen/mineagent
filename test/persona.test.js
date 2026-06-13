// Tests for the persona entry point. Run with `npm test`.
//
// We do not exercise a live Mineflayer connect here; the goal is to
// verify that startPersona wires the tool manifest, resolves the
// server from the right priority (arg > memory > prompt), and returns
// a structured result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startPersona,
  resolveServer,
  callTool,
  getToolManifest,
} from '../src/persona.js';
import { state, STATUS, setStatus, resetRuntime } from '../src/state.js';
import { clearLastServer, writeLastServer } from '../src/improve.js';
import { disconnectFromServer } from '../src/connection.js';
import { tools } from '../src/tools/index.js';

function cleanup() {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  clearLastServer();
  try { disconnectFromServer(); } catch { /* noop */ }
  state.config.host = null;
  state.config.port = 25565;
  state.config.username = 'MineAgent';
}

function withTimeout(personaPromise, ms) {
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ timedOut: true }), ms)
  );
  return Promise.race([personaPromise, timeout]);
}

test('startPersona returns the manifest even when host is missing', async () => {
  cleanup();
  const r = await startPersona({});
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'no_server');
  assert.ok(Array.isArray(r.manifest));
  assert.equal(r.manifest.length, tools.length);
  assert.equal(state.status, STATUS.DISCONNECTED);
});

test('startPersona uses the explicit host from args', async () => {
  cleanup();
  // Use a port that will refuse fast (closed loopback). The connect
  // will fail; we only care about the resolution path here. Guard
  // against a hang with a 2s timeout.
  const r = await withTimeout(
    startPersona({ host: '127.0.0.1', port: 1, attachChat: false }),
    2000
  );
  if (r.timedOut) {
    // The in-flight startPersona is still pending and will eventually
    // write to state.config and lastServerFile. cleanup() resets
    // config too so the leaked state cannot pollute the next test.
    cleanup();
    assert.fail('startPersona hung on connect — refusing port should fail fast');
  }
  assert.equal(r.source, 'argument');
  assert.equal(r.host, '127.0.0.1');
  assert.ok(r.manifest.length > 0);
  cleanup();
});

test('startPersona falls back to memory when no host is given', async () => {
  cleanup();
  // Point the remembered host at a port that refuses immediately, so
  // the connect path fails fast (within milliseconds) rather than
  // hanging on an unroutable IP. The intent is to verify the
  // resolution path, not the connect itself.
  writeLastServer({ host: '127.0.0.1', port: 1, username: 'Memo' });
  const r = await startPersona({ attachChat: false });
  // r is the structured persona result; it includes a failed connect
  // envelope from connectToServer (refused or unreachable).
  assert.equal(r.source, 'memory');
  assert.equal(r.host, '127.0.0.1');
  assert.equal(r.username, 'Memo');
  assert.equal(r.ok, false);
  assert.ok(['refused', 'unreachable'].includes(r.kind), `expected refused/unreachable, got ${r.kind}`);
  cleanup();
});

test('resolveServer respects argument > memory > prompt > none', async () => {
  cleanup();
  clearLastServer();

  // 1. No host, no memory, no prompt → none
  let r = await resolveServer({});
  assert.equal(r.source, 'none');
  assert.equal(r.host, null);

  // 2. Memory beats prompt
  writeLastServer({ host: 'mem-host', port: 25565, username: 'mem' });
  r = await resolveServer({
    prompt: true,
    promptFn: async () => ({ host: 'prompted-host', port: 25565 }),
  });
  assert.equal(r.source, 'memory');
  assert.equal(r.host, 'mem-host');
  clearLastServer();

  // 3. No memory → prompt
  r = await resolveServer({
    prompt: true,
    promptFn: async () => ({ host: 'prompted-host', port: 25565 }),
  });
  assert.equal(r.source, 'prompt');
  assert.equal(r.host, 'prompted-host');

  // 4. Arg beats memory
  writeLastServer({ host: 'mem-host', port: 25565, username: 'mem' });
  r = await resolveServer({ host: 'arg-host' });
  assert.equal(r.source, 'argument');
  assert.equal(r.host, 'arg-host');

  cleanup();
});

test('startPersona re-exports getToolManifest and callTool', () => {
  const m = getToolManifest();
  assert.ok(m.length > 0);
  assert.equal(typeof callTool, 'function');
});

test('cleanup', () => {
  cleanup();
});
