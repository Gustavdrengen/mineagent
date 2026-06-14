// Tests for the movement helpers in src/skills/movement.js.
//
// The Mineflayer pathfinder is faked with a minimal in-memory stub
// that records `setGoal` calls and lets tests emit the same events
// the real pathfinder emits. The bot exposes the small slice of the
// Mineflayer surface that the skill touches (`pathfinder.setGoal`,
// `blockAt`, `entity.position`, plus the Mineflayer `end`/`kicked`
// events on the bot itself).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  state,
  setStatus,
  resetRuntime,
  STATUS,
} from '../src/state.js';
import { moveToCoordinates } from '../src/skills/movement.js';

function makeBot({ solidAt = null, position = { x: 0, y: 64, z: 0 } } = {}) {
  const bot = new EventEmitter();
  bot.entity = { position };
  bot.pathfinder = new EventEmitter();
  let lastGoal = null;
  bot.pathfinder.setGoal = (goal) => {
    // finish() in movement.js calls setGoal(null) on settle; the test
    // helper would otherwise clobber the captured goal. Only record
    // the goal on the real set call.
    if (goal !== null) lastGoal = goal;
    bot.pathfinder.emit('goal_updated', goal, false);
  };
  bot.pathfinder.__lastGoal = () => lastGoal;
  bot.pathfinder.__clearGoal = () => {
    lastGoal = null;
  };
  bot.blockAt = (pos) => {
    if (!solidAt) return null;
    if (pos.x === solidAt.x && pos.y === solidAt.y && pos.z === solidAt.z) {
      return { type: 17 }; // any non-air id
    }
    return { type: 0 };
  };
  return bot;
}

// Start the bot far from the destination so the `goal_updated`
// short-circuit (already within tolerance) does not fire. Several
// tests below rely on the bot being "somewhere else" while we
// inspect the goal type or fire failure events.
const FAR_AWAY = { x: 100, y: 64, z: 100 };

test('moveToCoordinates rejects when not connected', async () => {
  resetRuntime();
  state.bot = null;
  const r = await moveToCoordinates({ x: 1, y: 64, z: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_connected');
});

test('moveToCoordinates rejects non-finite coords', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = makeBot();
  const r = await moveToCoordinates({ x: 1, y: Number.NaN, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'coords_invalid');
});

test('moveToCoordinates rejects non-finite timeout', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = makeBot();
  const r = await moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: -1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout_invalid');
});

test('moveToCoordinates uses GoalBlock when destination is air', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ solidAt: null, position: FAR_AWAY });
  state.bot = bot;
  // Use a longer timeout (the bot is far from the destination) and
  // resolve by emitting goal_reached after we've captured the goal.
  const promise = moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  const lastGoal = bot.pathfinder.__lastGoal();
  // GoalBlock has x/y/z and no rangeSq. GoalNear has rangeSq.
  assert.equal(lastGoal.x, 1);
  assert.equal(lastGoal.y, 64);
  assert.equal(lastGoal.z, 0);
  assert.equal(lastGoal.rangeSq, undefined, 'air destination should use GoalBlock (no rangeSq)');
  // Settle the call cleanly so node:test sees a resolution, not a timeout.
  bot.pathfinder.emit('goal_reached', lastGoal);
  const r = await promise;
  assert.equal(r.ok, true);
});

test('moveToCoordinates uses GoalNear when destination is a solid block (tree)', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ solidAt: { x: 5, y: 64, z: 5 } });
  state.bot = bot;
  // The bot starts at (0, 64, 0), not within tolerance of (5, 64, 5),
  // so it does not short-circuit. It should set a GoalNear goal.
  // The destination is a solid block: GoalNear range 1.
  const promise = moveToCoordinates({ x: 5, y: 64, z: 5, timeoutMs: 200 });
  // Allow the microtask queue to flush so setGoal is called.
  await new Promise((r) => setImmediate(r));
  const lastGoal = bot.pathfinder.__lastGoal();
  assert.equal(lastGoal.x, 5);
  assert.equal(lastGoal.y, 64);
  assert.equal(lastGoal.z, 5);
  assert.equal(lastGoal.rangeSq, 1, 'tree destination should use GoalNear(1)');
  // Settle by timing out (no goal_reached event).
  const r = await promise;
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout');
});

test('moveToCoordinates times out when the goal is never reached', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ position: FAR_AWAY });
  state.bot = bot;
  const start = Date.now();
  const r = await moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 50 });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'timeout');
  assert.ok(elapsed < 1000, `expected the call to resolve close to the timeout, not hang`);
});

test('moveToCoordinates surfaces partialPath as destination_blocked', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ position: FAR_AWAY });
  state.bot = bot;
  const promise = moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  // The pathfinder reports that it could only compute a partial path.
  bot.pathfinder.emit('path_update', { status: 'partialPath' });
  const r = await promise;
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'destination_blocked');
});

test('moveToCoordinates surfaces noPath as no_path', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ position: FAR_AWAY });
  state.bot = bot;
  const promise = moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  bot.pathfinder.emit('path_update', { status: 'noPath' });
  const r = await promise;
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'no_path');
});

test('moveToCoordinates resolves on goal_reached', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ position: FAR_AWAY });
  state.bot = bot;
  const promise = moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  bot.pathfinder.emit('goal_reached', bot.pathfinder.__lastGoal());
  const r = await promise;
  assert.equal(r.ok, true);
  assert.ok(r.arrivedAt);
});

test('moveToCoordinates surfaces disconnect mid-path', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ position: FAR_AWAY });
  state.bot = bot;
  const promise = moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  bot.emit('end');
  const r = await promise;
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_connected');
});

test('moveToCoordinates surfaces kicked mid-path', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ position: FAR_AWAY });
  state.bot = bot;
  const promise = moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  bot.emit('kicked', 'You are not whitelisted on this server');
  const r = await promise;
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'kicked');
});

test('moveToCoordinates timeoutMs=0 disables the timeout', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot({ position: FAR_AWAY });
  state.bot = bot;
  const promise = moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 0 });
  await new Promise((r) => setImmediate(r));
  // No event fires; the call should still settle via goal_reached.
  setImmediate(() => {
    bot.pathfinder.emit('goal_reached', bot.pathfinder.__lastGoal());
  });
  const r = await promise;
  assert.equal(r.ok, true);
});

test('moveToCoordinates resolves immediately on goal_updated when already within tolerance', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const bot = makeBot();
  // Bot is already at the destination within tolerance.
  bot.entity.position = { x: 1, y: 64, z: 0 };
  state.bot = bot;
  const r = await moveToCoordinates({ x: 1, y: 64, z: 0, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.arrivedAt, { x: 1, y: 64, z: 0 });
  assert.equal(r.pathLength, 0);
});

test('cleanup', () => {
  resetRuntime();
  state.bot = null;
});
