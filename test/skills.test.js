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

// --- new behavior: reachability, diggability, look-before-swing --------

test('mineBlock tags validation errors with stable kinds', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r1 = await mineBlock({ name: '', count: 1 });
  assert.equal(r1.kind, 'name_required');
  const r2 = await mineBlock({ name: 'dirt', count: 0 });
  assert.equal(r2.kind, 'count_invalid');
});

test('mineBlock tags not_connected and no_position', async () => {
  resetRuntime();
  state.bot = null;
  const r1 = await mineBlock({ name: 'dirt', count: 1 });
  assert.equal(r1.kind, 'not_connected');
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  // Registry must include 'dirt' so the new code reaches the
  // no_position check (which sits after the unknown_block check).
  state.bot = connectedBot({
    entity: null,
    registry: { blocksByName: { dirt: { id: 3 } } },
  });
  const r2 = await mineBlock({ name: 'dirt', count: 1 });
  assert.equal(r2.kind, 'no_position');
});

test('mineBlock skips an out-of-reach candidate and digs the next one', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  // Two oak_log blocks. The first is 10 blocks away (out of reach);
  // the second is 2 blocks away (within reach). The tool should
  // skip the first and dig the second.
  const farBlock = { type: 17, position: { x: 10, y: 64, z: 0 } };
  const nearBlock = { type: 17, position: { x: 2, y: 64, z: 0 } };
  const findCalls = [];
  const digCalls = [];
  const lookCalls = [];
  state.bot = connectedBot({
    registry: { blocksByName: { oak_log: { id: 17 } } },
    blockAt: (pos) => {
      // Both positions resolve to the matching block type.
      if (pos.x === 10) return farBlock;
      if (pos.x === 2) return nearBlock;
      return null;
    },
    findBlock: () => {
      // Return the far one first, the near one second.
      const next = findCalls.length === 0 ? farBlock : nearBlock;
      findCalls.push(next);
      return next;
    },
    dig: async (block) => { digCalls.push(block); },
    lookAt: async (pos) => { lookCalls.push(pos); },
  });
  const r = await mineBlock({ name: 'oak_log', count: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.blocksTouched, 1);
  // The tool tried twice: once for the out-of-reach one, once for
  // the reachable one. Only the second dig actually fired.
  assert.equal(findCalls.length, 2);
  assert.equal(digCalls.length, 1);
  assert.equal(digCalls[0], nearBlock);
  // The bot now uses Mineflayer's atomic look+dig (`bot.dig(target,
  // true)`), so the tool no longer issues a separate `lookAt` call.
  // The dig itself does the aiming. The legacy `lookAt` hook is
  // captured here only to assert it is NOT called — the persona
  // does not need to (and should not) pre-aim.
  assert.equal(lookCalls.length, 0);
});

test('mineBlock returns out_of_reach with the nearest position when nothing is reachable', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const farBlock = { type: 17, position: { x: 20, y: 64, z: 0 } };
  state.bot = connectedBot({
    registry: { blocksByName: { oak_log: { id: 17 } } },
    blockAt: () => farBlock,
    findBlock: () => farBlock,
    dig: async () => { throw new Error('should not have been called'); },
  });
  const r = await mineBlock({ name: 'oak_log', count: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'out_of_reach');
  assert.deepEqual(r.position, { x: 20, y: 64, z: 0 });
  assert.equal(r.nearest.name, 'oak_log');
  assert.match(r.error, /out of reach/);
});

test('mineBlock skips undiggable candidates (canDigBlock returns false)', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  // First call returns an undiggable block (bedrock-like), second
  // call returns a diggable one.
  const bedrock = { type: 17, position: { x: 1, y: 64, z: 0 } };
  const dirt = { type: 3, position: { x: 2, y: 64, z: 0 } };
  let callIndex = 0;
  const findBlock = () => (callIndex++ === 0 ? bedrock : dirt);
  state.bot = connectedBot({
    registry: { blocksByName: { oak_log: { id: 17 }, dirt: { id: 3 } } },
    blockAt: (pos) => (pos.x === 1 ? bedrock : dirt),
    findBlock,
    canDigBlock: (block) => block.type === 3,
    dig: async () => {},
  });
  const r = await mineBlock({ name: 'dirt', count: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.blocksTouched, 1);
});

test('mineBlock returns not_diggable when canDigBlock is false for every candidate', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bedrock = { type: 7, position: { x: 1, y: 64, z: 0 } };
  state.bot = connectedBot({
    registry: { blocksByName: { bedrock: { id: 7 } } },
    blockAt: () => bedrock,
    findBlock: () => bedrock,
    canDigBlock: () => false,
    dig: async () => { throw new Error('should not have been called'); },
  });
  const r = await mineBlock({ name: 'bedrock', count: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_diggable');
  assert.deepEqual(r.position, { x: 1, y: 64, z: 0 });
});

test('mineBlock re-resolves the block via blockAt before digging (handles world changes)', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const target = { type: 17, position: { x: 1, y: 64, z: 0 } };
  // First findBlock returns the target. blockAt returns null
  // (the block is gone — say another player broke it). The tool
  // should not dig; it should retry. Second findBlock returns
  // another reachable block, which digs cleanly.
  const target2 = { type: 17, position: { x: 2, y: 64, z: 0 } };
  const digCalls = [];
  let callIndex = 0;
  state.bot = connectedBot({
    registry: { blocksByName: { oak_log: { id: 17 } } },
    blockAt: (pos) => (pos.x === 1 ? null : target2),
    findBlock: () => (callIndex++ === 0 ? target : target2),
    dig: async (block) => { digCalls.push(block); },
  });
  const r = await mineBlock({ name: 'oak_log', count: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.blocksTouched, 1);
  // Only the second block was dug; the first was skipped because
  // blockAt returned null.
  assert.equal(digCalls.length, 1);
  assert.equal(digCalls[0], target2);
});

test('mineBlock dig_failed surfaces the Mineflayer error', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const target = { type: 17, position: { x: 1, y: 64, z: 0 } };
  state.bot = connectedBot({
    registry: { blocksByName: { oak_log: { id: 17 } } },
    blockAt: () => target,
    findBlock: () => target,
    dig: async () => { throw new Error('Player position is too far from block to dig'); },
  });
  const r = await mineBlock({ name: 'oak_log', count: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'dig_failed');
  assert.match(r.error, /too far/);
  assert.equal(r.blocksTouched, 0);
});

test('mineBlock no_block_in_range when findBlock returns null and no blocks were mined', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({
    registry: { blocksByName: { oak_log: { id: 17 } } },
    findBlock: () => null,
  });
  const r = await mineBlock({ name: 'oak_log', count: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'no_block_in_range');
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
