// Tests for the embedded observer.
//
// The observer is embedded in the MCP server so the agent's process
// owns the bot state and the events. These tests exercise the
// observer in isolation (driven by startObserverServer directly) and
// in combination with the MCP server (the agent's process is the
// observer's process).
//
// Every test cleans up its observer (and any spawned MCP server) in a
// finally block. A leaked HTTP server keeps the test runner alive
// until its hard timeout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startObserverServer } from '../server/index.js';
import { startMcpServer } from '../src/mcp-server.js';
import { setStatus, resetRuntime, STATUS, state, snapshot as snapshotState } from '../src/state.js';
import { emit } from '../src/events.js';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  return new Readable({ read() {} });
}

function makeTempPidfile(prefix) {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'pid');
}

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('fetch timeout')));
  });
}

function fetchJson(url) {
  return fetchRaw(url).then((r) => ({
    status: r.status,
    body: JSON.parse(r.body),
  }));
}

function postJson(url, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: new URL(url).port,
        method: 'POST',
        path: new URL(url).pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function openCollector(url) {
  // Returns a WebSocket plus a messages array and a `waitFor(predicate, timeoutMs)`
  // helper that resolves when a message matching the predicate arrives, or
  // rejects on timeout. Avoids the timing-fragile `setTimeout(50)` pattern.
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(msg)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  const waitFor = (predicate, timeoutMs = 1000) =>
    new Promise((resolve, reject) => {
      const existing = messages.find(predicate);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('waitFor timed out'));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  const open = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, messages, waitFor, open };
}

test('startObserverServer serves the static UI on the configured port', async () => {
  let handle = null;
  try {
    handle = await startObserverServer({ port: 0 });
    const r = await fetchRaw(`http://127.0.0.1:${handle.port}/`);
    assert.equal(r.status, 200);
    assert.match(r.contentType, /text\/html/);
    assert.match(r.body, /<title>MineAgent Observer<\/title>/);
    // Static assets are served too.
    const app = await fetchRaw(`http://127.0.0.1:${handle.port}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.contentType, /application\/javascript/);
    const css = await fetchRaw(`http://127.0.0.1:${handle.port}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.contentType, /text\/css/);
  } finally {
    if (handle) await handle.stop();
  }
});

test('startObserverServer returns 404 for unknown routes', async () => {
  let handle = null;
  try {
    handle = await startObserverServer({ port: 0 });
    const r = await fetchRaw(`http://127.0.0.1:${handle.port}/nope`);
    assert.equal(r.status, 404);
  } finally {
    if (handle) await handle.stop();
  }
});

test('startObserverServer exposes /api/state with the current snapshot', async () => {
  resetRuntime();
  setStatus(STATUS.DISCONNECTED);
  let handle = null;
  try {
    handle = await startObserverServer({ port: 0 });
    const r = await fetchJson(`http://127.0.0.1:${handle.port}/api/state`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, STATUS.DISCONNECTED);
  } finally {
    if (handle) await handle.stop();
  }
});

test('startObserverServer exposes /status with the connection snapshot', async () => {
  resetRuntime();
  setStatus(STATUS.DISCONNECTED);
  let handle = null;
  try {
    handle = await startObserverServer({ port: 0 });
    const r = await fetchJson(`http://127.0.0.1:${handle.port}/status`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, STATUS.DISCONNECTED);
    assert.equal(r.body.username, 'MineAgent');
  } finally {
    if (handle) await handle.stop();
  }
});

test('startObserverServer broadcasts events to connected WebSocket clients', async () => {
  resetRuntime();
  let handle = null;
  let collector = null;
  try {
    handle = await startObserverServer({ port: 0 });
    collector = openCollector(`ws://127.0.0.1:${handle.port}/ws`);
    await collector.open;
    // Initial snapshot arrives via the WebSocket connection handler.
    const snapshot = await collector.waitFor((m) => m.event === 'snapshot');
    assert.equal(snapshot.event, 'snapshot');

    // Emit a custom event; the observer should rebroadcast it.
    emit('chat', { username: 'tester', message: 'hello' });
    const chatMsg = await collector.waitFor(
      (m) => m.event === 'chat' && m.payload && m.payload.username === 'tester'
    );
    assert.equal(chatMsg.payload.message, 'hello');
  } finally {
    if (collector) collector.ws.close();
    if (handle) await handle.stop();
  }
});

test('startObserverServer detaches its event subscription on stop', async () => {
  let handle = null;
  try {
    handle = await startObserverServer({ port: 0 });
    // Capture the listener count via a second subscribe: the events
    // module's listener Set is a closure, so we can't read its size
    // directly. Instead, we exercise the subscription path: open a
    // second observer, capture its broadcast via a real WebSocket,
    // and verify that stopping the first observer does not affect
    // the second's broadcasts. Then stop the second and verify the
    // port is freed.
    const handle2 = await startObserverServer({ port: 0 });
    const collector = openCollector(`ws://127.0.0.1:${handle2.port}/ws`);
    await collector.open;
    await collector.waitFor((m) => m.event === 'snapshot');

    emit('chat', { username: 'a', message: 'one' });
    await collector.waitFor((m) => m.event === 'chat' && m.payload.message === 'one');

    await handle.stop();
    // After stop, the first observer's HTTP server is closed.
    let firstReachable = true;
    try {
      await fetchRaw(`http://127.0.0.1:${handle.port}/api/state`);
    } catch {
      firstReachable = false;
    }
    assert.equal(firstReachable, false, 'first observer should be unreachable after stop');

    // The second observer still works (independent subscriptions).
    emit('chat', { username: 'b', message: 'two' });
    await collector.waitFor((m) => m.event === 'chat' && m.payload.message === 'two');

    collector.ws.close();
    await handle2.stop();
  } finally {
    if (handle) await handle.stop();
  }
});

test('startObserverServer /api/say forwards to chat when sendToGame is not false', async () => {
  resetRuntime();
  setStatus(STATUS.DISCONNECTED);
  // say() returns a not_connected envelope when the bot is offline.
  // The HTTP route should mirror that and never 500.
  let handle = null;
  try {
    handle = await startObserverServer({ port: 0 });
    const r = await postJson(`http://127.0.0.1:${handle.port}/api/say`, {
      text: 'hi from the test',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.chat.kind, 'not_connected');
  } finally {
    if (handle) await handle.stop();
  }
});

test('startObserverServer /api/say rejects empty text with 400', async () => {
  let handle = null;
  try {
    handle = await startObserverServer({ port: 0 });
    const r = await postJson(`http://127.0.0.1:${handle.port}/api/say`, {
      text: '   ',
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  } finally {
    if (handle) await handle.stop();
  }
});

test('startObserverServer /api/say respects sendToGame: false', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  // With sendToGame: false, the route returns a synthetic ok envelope
  // and never calls say(). Useful for the browser "test voice" button.
  let handle = null;
  try {
    handle = await startObserverServer({ port: 0 });
    const r = await postJson(`http://127.0.0.1:${handle.port}/api/say`, {
      text: 'voice only',
      sendToGame: false,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.voice.text, 'voice only');
  } finally {
    if (handle) await handle.stop();
  }
});

test('startMcpServer starts the embedded observer by default', async () => {
  // Reset state first — prior tests in this file may have left the
  // state as `connected`, which would make the default-disconnected
  // assertion fail.
  resetRuntime();
  setStatus(STATUS.DISCONNECTED);
  const dir = makeTempPidfile('mineagent-mcp-obs-');
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: dir,
      observer: { port: 0 },
    });
    assert.ok(handle.observer, 'observer handle should be returned');
    assert.ok(handle.observer.port > 0, 'observer should be bound to a real port');
    // The embedded observer should serve /api/state from the same
    // process as the MCP server, so the snapshot reflects the actual
    // connection state (default: disconnected, since no bot is up).
    const r = await fetchJson(`http://127.0.0.1:${handle.observer.port}/api/state`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, STATUS.DISCONNECTED);
  } finally {
    if (handle) await handle.stop();
    stdin.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startMcpServer observer: false skips starting the observer', async () => {
  const dir = makeTempPidfile('mineagent-mcp-noobs-');
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: dir,
      observer: false,
    });
    assert.equal(handle.observer, null, 'observer handle should be null when opted out');
  } finally {
    if (handle) await handle.stop();
    stdin.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startMcpServer tolerates a port conflict (observer logs a warning, MCP server still runs)', async () => {
  // Pre-bind a server to a port; pass that same port to the MCP
  // server. The embedded observer should fail to bind, the MCP
  // server should keep running, and handle.observer should be null.
  let squatter = null;
  const dir = makeTempPidfile('mineagent-mcp-conflict-');
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  try {
    squatter = http.createServer();
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const squatterPort = squatter.address().port;

    const logs = [];
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: dir,
      observer: { port: squatterPort, host: '127.0.0.1' },
      logger: (m) => logs.push(m),
    });
    assert.ok(handle, 'MCP server should be alive despite observer failure');
    assert.equal(handle.observer, null, 'observer should be null after bind failure');
    const sawWarning = logs.some((l) => l.includes('[observer]'));
    assert.ok(sawWarning, 'expected an [observer] warning in the logger');
  } finally {
    if (squatter) {
      await new Promise((resolve) => squatter.close(() => resolve()));
    }
    if (handle) await handle.stop();
    stdin.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('embedded observer reflects a real connection state change (snapshot + event flow)', async () => {
  // End-to-end-ish: the MCP server starts, the agent "connects" by
  // mutating state directly, and the embedded observer's WebSocket
  // receives the state change in real time. This is the test that
  // would have caught the cross-process bug the user reported.
  resetRuntime();
  setStatus(STATUS.DISCONNECTED);
  const dir = makeTempPidfile('mineagent-mcp-e2e-');
  const stdin = makeLineReadable();
  const stdout = makeBufferedWritable();
  let handle = null;
  let collector = null;
  try {
    handle = await startMcpServer({
      shutdownExisting: false,
      installCleanup: false,
      input: stdin,
      output: stdout,
      pidfile: dir,
      observer: { port: 0 },
    });
    collector = openCollector(`ws://127.0.0.1:${handle.observer.port}/ws`);
    await collector.open;
    await collector.waitFor((m) => m.event === 'snapshot');

    // Simulate a connect. This is what would happen when the agent
    // calls the connect_to_server tool: setStatus(CONNECTED) + a
    // 'status' event with the new snapshot.
    setStatus(STATUS.CONNECTED);
    state.config.host = '127.0.0.1';
    state.config.port = 25565;
    state.config.username = 'MineAgent';
    emit('status', snapshotState());

    const statusEvent = await collector.waitFor(
      (m) => m.event === 'status' && m.payload && m.payload.status === STATUS.CONNECTED
    );
    assert.equal(statusEvent.payload.host, '127.0.0.1');

    // The HTTP /api/state should also reflect the new state — the
    // observer is reading the same in-process snapshot the agent
    // mutates, not a stale copy.
    const r = await fetchJson(`http://127.0.0.1:${handle.observer.port}/api/state`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, STATUS.CONNECTED);
  } finally {
    if (collector) collector.ws.close();
    if (handle) await handle.stop();
    stdin.destroy();
    rmSync(dir, { recursive: true, force: true });
    resetRuntime();
  }
});

test('cleanup', () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
});
