// Tests for the executable skills. Run with `npm test`.
//
// These tests exercise the pure logic in each skill (validation, parsing,
// command routing). The parts that need a real Mineflayer bot are
// guarded with a `connectedBot` helper that fakes the surface the skill
// uses (registry, inventory, entity, chat). Live Mineflayer tests
// require a real server and live in the integration test suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  state,
  setCurrentTask,
  setInventory,
  resetRuntime,
  setStatus,
  STATUS,
} from '../src/state.js';
import { status } from '../src/skills/status.js';
import { parseCommand, handleCommand, builtins } from '../src/skills/chat.js';
import {
  mineBlock,
  placeBlock,
  lookAtBlock,
} from '../src/skills/world-interaction.js';

function connectedBot(extra = {}) {
  return {
    registry: { blocksByName: {} },
    inventory: { items: () => [], on: () => {} },
    entity: { position: { x: 0, y: 64, z: 0 } },
    chat: () => {},
    players: {},
    ...extra,
  };
}

// ---------- status ----------

test('status returns not-connected when no bot', () => {
  resetRuntime();
  state.bot = null;
  const s = status();
  assert.equal(s.ok, true);
  assert.equal(s.connected, false);
  assert.ok(s.error);
});

test('status includes only requested fields', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  setInventory([{ slot: 0, name: 'oak_log', count: 1 }]);
  setCurrentTask('idle');
  const s = status({ include: ['task'] });
  assert.ok('currentTask' in s, `missing currentTask in ${JSON.stringify(s)}`);
  assert.ok(!('inventory' in s), `inventory leaked into ${JSON.stringify(s)}`);
});

// ---------- chat ----------

test('parseCommand splits a `!cmd arg1 arg2` line', () => {
  const p = parseCommand('!status please');
  assert.equal(p.name, '!status');
  assert.deepEqual(p.args, ['please']);
});

test('parseCommand returns null for non-command messages', () => {
  assert.equal(parseCommand('hello there'), null);
});

test('chat builtins include status, inventory, come, stop, look, help', () => {
  for (const k of ['!status', '!inventory', '!come', '!stop', '!look', '!help']) {
    assert.ok(k in builtins, `missing builtin: ${k}`);
  }
});

test('handleCommand treats unknown commands as not-handled', async () => {
  const r = await handleCommand({ from: 'tester', message: '!nope' });
  assert.equal(r.ok, true);
  assert.equal(r.handled, false);
});

// ---------- world-interaction (validation against a fake bot) ----------

test('mineBlock rejects when not connected', async () => {
  resetRuntime();
  state.bot = null;
  const r = await mineBlock({ name: 'oak_log', count: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/);
});

test('mineBlock rejects missing name', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = await mineBlock({ name: '', count: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /name is required/);
});

test('mineBlock rejects invalid count', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ registry: { blocksByName: { dirt: { id: 1 } } } });
  const r = await mineBlock({ name: 'dirt', count: 0 });
  assert.equal(r.ok, false);
});

test('mineBlock rejects unknown block name', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ registry: { blocksByName: { dirt: { id: 1 } } } });
  const r = await mineBlock({ name: 'unobtanium', count: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown block/);
});

test('placeBlock rejects when not connected', async () => {
  resetRuntime();
  state.bot = null;
  const r = await placeBlock({ name: 'oak_log', position: { x: 0, y: 0, z: 0 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/);
});

test('placeBlock rejects missing name', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = await placeBlock({ position: { x: 0, y: 0, z: 0 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /name is required/);
});

test('placeBlock rejects missing position', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = await placeBlock({ name: 'oak_log' });
  assert.equal(r.ok, false);
  assert.match(r.error, /position is required/);
});

test('placeBlock rejects when the block is not in inventory', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ Vec3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } } });
  const r = await placeBlock({ name: 'oak_log', position: { x: 0, y: 0, z: 0 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no oak_log in inventory/);
});

test('lookAtBlock rejects when not connected', async () => {
  resetRuntime();
  state.bot = null;
  const r = await lookAtBlock({ position: { x: 0, y: 0, z: 0 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/);
});

test('lookAtBlock rejects missing position', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = await lookAtBlock({});
  assert.equal(r.ok, false);
  assert.match(r.error, /position is required/);
});

// Final cleanup so other test files start fresh.
test('cleanup', () => {
  resetRuntime();
  state.bot = null;
  assert.equal(state.bot, null);
});
