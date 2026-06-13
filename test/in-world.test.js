// Tests for the in-world action helpers in src/skills/in-world.js.
//
// We exercise the not-connected, validation, and happy-path branches
// against a fake Mineflayer bot surface. The pieces that need a real
// connection (e.g. bot.equip actually moving an item) are guarded with
// a `connectedBot` helper that mimics the parts of the Mineflayer API
// these helpers call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  state,
  setStatus,
  setInventory,
  resetRuntime,
  recordChat,
  STATUS,
} from '../src/state.js';
import {
  equipItem,
  dropItem,
  useHeldItem,
  readChatHistory,
  scanNearbyEntities,
  getBlockInfo,
  findBlock,
  lookAtPosition,
  attackEntity,
} from '../src/skills/in-world.js';
import { say } from '../src/skills/chat.js';

function connectedBot(extra = {}) {
  const items = (extra.items || []).slice();
  return {
    username: 'MineAgent',
    registry: { blocksByName: { dirt: { id: 3 } } },
    inventory: {
      items: () => items,
      on: () => {},
    },
    entity: { position: { x: 0, y: 64, z: 0 } },
    players: {},
    entities: {},
    equip: async () => {},
    toss: async () => {},
    activateItem: async () => {},
    attack: () => {},
    lookAt: async () => {},
    blockAt: () => null,
    findBlock: () => null,
    ...extra,
  };
}

test('read_chat_history returns the most recent messages', () => {
  resetRuntime();
  for (let i = 0; i < 5; i++) recordChat('tester', `hi ${i}`);
  const r = readChatHistory({ limit: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(r.messages[0].message, 'hi 2');
  assert.equal(r.messages[2].message, 'hi 4');
});

test('read_chat_history caps limit at 100', () => {
  resetRuntime();
  const r = readChatHistory({ limit: 9999 });
  assert.equal(r.ok, true);
  assert.ok(r.count <= 100);
});

test('read_chat_history works when disconnected', () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  recordChat('tester', 'still here');
  const r = readChatHistory({ limit: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
});

test('equip_item rejects when not connected', async () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  const r = await equipItem({ name: 'iron_pickaxe' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_connected');
});

test('equip_item rejects missing name', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = await equipItem({ name: '' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'name_required');
});

test('equip_item rejects when item is not in inventory', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = await equipItem({ name: 'diamond_sword' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'item_missing');
});

test('equip_item equips and returns ok', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  let calledWith = null;
  state.bot = connectedBot({
    items: [{ name: 'iron_pickaxe', type: 250, metadata: 0, count: 1, slot: 0 }],
    equip: async (item, dest) => { calledWith = { item, dest }; },
  });
  const r = await equipItem({ name: 'iron_pickaxe', destination: 'hand' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'equip');
  assert.equal(calledWith.item.name, 'iron_pickaxe');
  assert.equal(calledWith.dest, 'hand');
});

test('equip_item propagates equip errors', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({
    items: [{ name: 'oak_log', type: 17, metadata: 0, count: 1, slot: 0 }],
    equip: async () => { throw new Error('cannot equip log to head'); },
  });
  const r = await equipItem({ name: 'oak_log', destination: 'head' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'equip_failed');
  assert.match(r.error, /cannot equip log to head/);
});

test('drop_item rejects when not connected', async () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  const r = await dropItem({ name: 'dirt' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_connected');
});

test('drop_item rejects invalid count', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ items: [{ name: 'dirt', type: 3, metadata: 0, count: 5, slot: 0 }] });
  const r = await dropItem({ name: 'dirt', count: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'count_invalid');
});

test('drop_item rejects when item missing', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = await dropItem({ name: 'diamond', count: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'item_missing');
});

test('drop_item tosses and reports count', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  let tossArgs = null;
  state.bot = connectedBot({
    items: [{ name: 'dirt', type: 3, metadata: 0, count: 5, slot: 0 }],
    toss: async (type, metadata, count) => { tossArgs = { type, metadata, count }; },
  });
  const r = await dropItem({ name: 'dirt', count: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'drop');
  assert.equal(tossArgs.count, 2);
});

test('use_held_item rejects when not connected', async () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  const r = await useHeldItem();
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_connected');
});

test('use_held_item activates the held item', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  let activated = false;
  state.bot = connectedBot({ activateItem: async () => { activated = true; } });
  const r = await useHeldItem();
  assert.equal(r.ok, true);
  assert.equal(activated, true);
});

test('scan_nearby_entities rejects when not connected', () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  const r = scanNearbyEntities({});
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_connected');
});

test('scan_nearby_entities filters by distance and type', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({
    entities: {
      1: { id: 1, name: 'Creeper', type: 'mob', position: { x: 2, y: 64, z: 0 } },
      2: { id: 2, name: 'Cow', type: 'mob', position: { x: 3, y: 64, z: 0 } },
      3: { id: 2, username: 'Alice', type: 'player', position: { x: 50, y: 64, z: 0 } },
      4: { id: 3, name: 'Item', type: 'other', position: { x: 5, y: 64, z: 0 } },
    },
  });
  // Assert presence by name rather than count, so a future fixture
  // bump (adding a new entity) doesn't ripple through every count.
  const all = scanNearbyEntities({ maxDistance: 100, type: 'all' });
  assert.equal(all.ok, true);
  for (const name of ['Creeper', 'Cow', 'Alice', 'Item']) {
    assert.ok(all.entities.find((e) => e.name === name || e.username === name), `missing ${name} in 'all'`);
  }
  const hostile = scanNearbyEntities({ maxDistance: 100, type: 'hostile' });
  assert.ok(hostile.entities.find((e) => e.name === 'Creeper'), 'Creeper should be hostile');
  assert.equal(hostile.entities.find((e) => e.name === 'Cow'), undefined, 'Cow should not be hostile');
  const passive = scanNearbyEntities({ maxDistance: 100, type: 'passive' });
  assert.ok(passive.entities.find((e) => e.name === 'Cow'), 'Cow should be passive');
  assert.equal(passive.entities.find((e) => e.name === 'Creeper'), undefined, 'Creeper should not be passive');
  const mobs = scanNearbyEntities({ maxDistance: 100, type: 'mob' });
  assert.ok(mobs.entities.find((e) => e.name === 'Creeper'), 'Creeper should be in mobs');
  assert.ok(mobs.entities.find((e) => e.name === 'Cow'), 'Cow should be in mobs');
  const farAway = scanNearbyEntities({ maxDistance: 10, type: 'all' });
  assert.equal(farAway.entities.find((e) => e.username === 'Alice'), undefined, 'Alice is at 50 blocks, not within 10');
});

test('get_block_info rejects non-finite coords', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = getBlockInfo({ x: 1, y: Number.NaN, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'coords_invalid');
});

test('get_block_info returns null when no block', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ blockAt: () => null });
  const r = getBlockInfo({ x: 0, y: 0, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.block, null);
  // `kind` is reserved for error categories. A successful lookup that
  // found nothing returns `block: null` and no `kind`.
  assert.equal(r.kind, undefined);
});

test('get_block_info returns the block metadata', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({
    blockAt: () => ({ name: 'dirt', type: 3, metadata: 0, hardness: 0.5, transparent: false }),
  });
  const r = getBlockInfo({ x: 0, y: 64, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.block.name, 'dirt');
  assert.equal(r.block.hardness, 0.5);
});

test('find_block rejects when not connected', () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  const r = findBlock({ name: 'dirt' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_connected');
});

test('find_block rejects unknown block name', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = findBlock({ name: 'unobtanium' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown_block');
});

test('find_block returns found=false when no block in range', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ findBlock: () => null });
  const r = findBlock({ name: 'dirt' });
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
});

test('find_block returns the position when found', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ findBlock: () => ({ position: { x: 3, y: 64, z: -2 } }) });
  const r = findBlock({ name: 'dirt' });
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.position.x, 3);
});

test('look_at_position rejects non-finite coords', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = await lookAtPosition({ x: 1, y: 2, z: Number.POSITIVE_INFINITY });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'coords_invalid');
});

test('look_at_position calls bot.lookAt', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  let lookedAt = null;
  state.bot = connectedBot({ lookAt: async (p) => { lookedAt = p; } });
  const r = await lookAtPosition({ x: 1, y: 2, z: 3 });
  assert.equal(r.ok, true);
  assert.equal(lookedAt.x, 1);
  assert.equal(lookedAt.y, 2);
  assert.equal(lookedAt.z, 3);
});

test('attack_entity requires username or entityId', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = attackEntity({});
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'target_required');
});

test('attack_entity reports target_missing when player is not visible', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ players: {} });
  const r = attackEntity({ username: 'Bob' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'target_missing');
});

test('attack_entity attacks the resolved entity', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const target = { id: 42 };
  let attacked = null;
  state.bot = connectedBot({
    players: { Bob: { entity: target } },
    attack: (e) => { attacked = e; },
  });
  const r = attackEntity({ username: 'Bob' });
  assert.equal(r.ok, true);
  assert.equal(attacked, target);
});

test('scan_nearby_entities reports no_position when bot has no position', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ entity: null });
  const r = scanNearbyEntities({ type: 'all' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'no_position');
});

test('attack_entity reports no_position when bot has no position', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot({ entity: null });
  const r = attackEntity({ username: 'Bob' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'no_position');
});

test('attack_entity resolves target by entityId', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  const target = { id: 99 };
  let attacked = null;
  state.bot = connectedBot({
    entities: { 99: target },
    attack: (e) => { attacked = e; },
  });
  const r = attackEntity({ entityId: 99 });
  assert.equal(r.ok, true);
  assert.equal(attacked, target);
});

test('say() returns not_connected envelope when bot is offline', () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  const r = say({ message: 'hello' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'not_connected');
  assert.match(r.error, /not connected/);
});

test('say() returns message_required envelope for empty text', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = say({ message: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'message_required');
});

test('say() returns message_required envelope for non-string input', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = connectedBot();
  const r = say({ message: 42 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'message_required');
});

test('say() accepts the string "0" (truthiness check is not length check)', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  let chattedWith = null;
  state.bot = {
    username: 'MineAgent',
    chat: (text) => { chattedWith = text; },
  };
  const r = say({ message: '0' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '0');
  assert.equal(chattedWith, '0');
});

test('say() returns ok envelope when bot is online', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  let chattedWith = null;
  state.bot = {
    username: 'MineAgent',
    chat: (text) => { chattedWith = text; },
  };
  const r = say({ message: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(r.message, 'hello');
  assert.equal(chattedWith, 'hello');
});

test('say() re-throws unknown errors (no kind field)', () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = {
    username: 'MineAgent',
    chat: () => { throw new Error('bot exploded'); },
  };
  // Unknown errors are genuine bugs; say() re-throws them so the
  // caller's try/catch or the test runner sees the failure, not a
  // silently-swallowed envelope.
  assert.throws(() => say({ message: 'hello' }), /bot exploded/);
});

test('cleanup', () => {
  resetRuntime();
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
});
