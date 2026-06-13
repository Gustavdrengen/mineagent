// In-world action helpers for the MineAgent persona.
//
// Each function is a thin wrapper over the Mineflayer `state.bot`
// surface. They all return a structured `{ ok, error?, kind? }` envelope
// and never throw, so the tool layer and the agent loop can always
// branch on the result. The connection-state and bot-presence checks
// happen at the top of every function so callers (the registry's
// `execute` functions, the `runGoal` parser, the chat dispatch path)
// do not have to duplicate them.
//
// This module is the home for the broad API the persona can call to
// actually *do* things in the Minecraft world: observe, equip, drop,
// use, attack, find, and look. The movement and world-interaction
// primitives live in their own modules (`movement.js`,
// `world-interaction.js`) because they predate this file and are
// already tested.

import { state, setCurrentTask, recordAction, setInventory, snapshot } from '../state.js';
import { emit } from '../events.js';

function getBot() {
  return state.bot;
}

function refreshInventory(bot) {
  if (!bot || !bot.inventory) return;
  try {
    const items = bot.inventory.items
      ? bot.inventory.items()
      : Array.from(bot.inventory.slots || []).filter(Boolean);
    setInventory(
      items.map((item, idx) => ({
        slot: item.slot ?? idx,
        name: item.name,
        count: item.count,
      }))
    );
  } catch {
    // best effort; the next state poll will catch up
  }
  emit('state', snapshot());
}

function requireConnected() {
  const bot = getBot();
  if (!bot || state.status !== 'connected') {
    return { ok: false, error: 'not connected', kind: 'not_connected' };
  }
  return { ok: true, bot };
}

// --- Inventory ----------------------------------------------------------

// Equip an item from the bot's inventory by name. `destination` defaults
// to the hand. Accepts the same destinations Mineflayer supports:
// hand, head, torso, legs, feet, off-hand.
export async function equipItem({ name, destination = 'hand' } = {}) {
  const conn = requireConnected();
  if (!conn.ok) return conn;
  if (!name) return { ok: false, error: 'name is required', kind: 'name_required' };
  const item = conn.bot.inventory.items().find((i) => i.name === name);
  if (!item) {
    return { ok: false, error: `no ${name} in inventory`, kind: 'item_missing' };
  }
  try {
    await conn.bot.equip(item, destination);
    setCurrentTask(`equip ${name} -> ${destination}`);
    recordAction('equip', `${name} -> ${destination}`);
    emit('state', snapshot());
    return { ok: true, action: 'equip', name, destination };
  } catch (err) {
    return { ok: false, error: err.message, kind: 'equip_failed' };
  }
}

// Drop an item from the bot's inventory. `count` defaults to 1. If the
// bot has fewer than `count`, the bot's reported count is used.
export async function dropItem({ name, count = 1 } = {}) {
  const conn = requireConnected();
  if (!conn.ok) return conn;
  if (!name) return { ok: false, error: 'name is required', kind: 'name_required' };
  if (typeof count !== 'number' || count < 1) {
    return { ok: false, error: 'count must be a positive number', kind: 'count_invalid' };
  }
  const item = conn.bot.inventory.items().find((i) => i.name === name);
  if (!item) {
    return { ok: false, error: `no ${name} in inventory`, kind: 'item_missing' };
  }
  try {
    await conn.bot.toss(item.type, item.metadata ?? null, Math.min(count, item.count));
    setCurrentTask(`drop ${count} ${name}`);
    recordAction('drop', `${count} ${name}`);
    refreshInventory(conn.bot);
    return { ok: true, action: 'drop', name, count };
  } catch (err) {
    return { ok: false, error: err.message, kind: 'drop_failed' };
  }
}

// Use the held item (right-click). Equivalent to `bot.activateItem()`.
export async function useHeldItem() {
  const conn = requireConnected();
  if (!conn.ok) return conn;
  try {
    await conn.bot.activateItem();
    setCurrentTask('use held item');
    recordAction('use', 'held item');
    emit('state', snapshot());
    return { ok: true, action: 'use' };
  } catch (err) {
    return { ok: false, error: err.message, kind: 'use_failed' };
  }
}

// --- Observation --------------------------------------------------------

// Read the last `limit` chat messages from the shared chat history.
// `limit` defaults to 20; capped at 100 (the history's bound).
export function readChatHistory({ limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const tail = state.chatHistory.slice(-safeLimit);
  return { ok: true, messages: tail, count: tail.length };
}

// Scan nearby entities. Filters by `type` — the only Mineflayer
// `e.type` values are 'player', 'mob', and 'other'; the tool's enum
// also accepts 'hostile' and 'passive', which we classify on top of
// `e.name` (peaceful mob names count as passive). The 'all' value
// skips the filter.
export function scanNearbyEntities({ maxDistance = 32, type = 'all' } = {}) {
  const conn = requireConnected();
  if (!conn.ok) return conn;
  const bot = conn.bot;
  if (!bot.entity || !bot.entity.position) {
    return { ok: false, error: 'bot is not in a world yet', kind: 'no_position' };
  }
  const here = bot.entity.position;
  const matches = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position) continue;
    const dx = e.position.x - here.x;
    const dy = e.position.y - here.y;
    const dz = e.position.z - here.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDistance) continue;
    if (!matchesType(e, type)) continue;
    matches.push({
      id: e.id,
      name: e.name || null,
      username: e.username || null,
      type: e.type || null,
      kind: e.kind || null,
      distance: Math.round(dist * 10) / 10,
      position: {
        x: Math.floor(e.position.x),
        y: Math.floor(e.position.y),
        z: Math.floor(e.position.z),
      },
    });
  }
  return { ok: true, count: matches.length, entities: matches };
}

// Hardcoded passivity list for the `type: 'passive'` / `type: 'hostile'`
// filters in `scanNearbyEntities`. **World-version-specific:** this list
// tracks Minecraft 1.21 mobs; new releases may add passive or hostile
// variants. Any `type: 'mob'` entity whose name is not in this set is
// treated as hostile. Keep this list in sync with Mineflayer's
// registry, or better, derive it from `bot.registry.entitiesByName`
// when that data is available.
const PASSIVE_MOBS = new Set([
  'Chicken', 'Cow', 'Pig', 'Sheep', 'Rabbit', 'Horse', 'Donkey', 'Mule',
  'Squid', 'TropicalFish', 'Cod', 'Salmon', 'Pufferfish', 'Turtle',
  'Bee', 'Fox', 'Cat', 'Wolf', 'Parrot', 'Llama', 'Panda', 'Dolphin',
  'Ocelot', 'MushroomCow', 'Snowman', 'IronGolem', 'Villager', 'WanderingTrader',
  'Strider', 'Hoglin', 'Axolotl', 'GlowSquid', 'Goat', 'Frog', 'Tadpole',
  'Camel', 'Armadillo',
]);

function matchesType(entity, type) {
  if (type === 'all') return true;
  if (entity.type === type) return true;
  if (type === 'hostile' && entity.type === 'mob') {
    return !PASSIVE_MOBS.has(entity.name);
  }
  if (type === 'passive' && entity.type === 'mob') {
    return PASSIVE_MOBS.has(entity.name);
  }
  return false;
}

// Get the block at a position. Returns the block name and metadata.
export function getBlockInfo({ x, y, z } = {}) {
  const conn = requireConnected();
  if (!conn.ok) return conn;
  for (const v of [x, y, z]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, error: 'x, y, z must be finite numbers', kind: 'coords_invalid' };
    }
  }
  const pos = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  try {
    const block = conn.bot.blockAt(pos);
    if (!block) {
      // `kind` is reserved for error categories in this codebase; a
      // successful lookup that found nothing is just `block: null`.
      return { ok: true, position: pos, block: null };
    }
    return {
      ok: true,
      position: pos,
      block: {
        name: block.name,
        type: block.type,
        metadata: block.metadata,
        hardness: block.hardness ?? null,
        transparent: !!block.transparent,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message, kind: 'block_lookup_failed' };
  }
}

// Find the nearest block of a given name within `maxDistance` blocks.
// Returns the position or null. Wraps Mineflayer's `findBlock`.
export function findBlock({ name, maxDistance = 16 } = {}) {
  const conn = requireConnected();
  if (!conn.ok) return conn;
  if (!name) return { ok: false, error: 'name is required', kind: 'name_required' };
  const id = conn.bot.registry?.blocksByName?.[name]?.id ?? null;
  if (id == null) {
    return { ok: false, error: `unknown block: ${name}`, kind: 'unknown_block' };
  }
  const target = conn.bot.findBlock({ matching: id, maxDistance });
  if (!target) {
    return { ok: true, found: false, position: null };
  }
  return {
    ok: true,
    found: true,
    position: {
      x: Math.floor(target.position.x),
      y: Math.floor(target.position.y),
      z: Math.floor(target.position.z),
    },
  };
}

// Look at an arbitrary position (not necessarily a block). Useful for
// looking at the sky, an entity, or any other point of interest.
export async function lookAtPosition({ x, y, z } = {}) {
  const conn = requireConnected();
  if (!conn.ok) return conn;
  for (const v of [x, y, z]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, error: 'x, y, z must be finite numbers', kind: 'coords_invalid' };
    }
  }
  try {
    await conn.bot.lookAt({ x, y, z });
    recordAction('look', `${x},${y},${z}`);
    emit('state', snapshot());
    return { ok: true, position: { x, y, z } };
  } catch (err) {
    return { ok: false, error: err.message, kind: 'look_failed' };
  }
}

// --- Combat -------------------------------------------------------------

// Attack an entity. The agent can pass `username` (for a player) or
// `entityId` (for any entity). At least one is required. Sync, because
// bot.attack is synchronous.
export function attackEntity({ username, entityId } = {}) {
  const conn = requireConnected();
  if (!conn.ok) return conn;
  const bot = conn.bot;
  if (!bot.entity || !bot.entity.position) {
    return { ok: false, error: 'bot is not in a world yet', kind: 'no_position' };
  }
  let target = null;
  if (typeof entityId === 'number') {
    target = bot.entities[entityId];
  } else if (username) {
    target = bot.players[username]?.entity;
  } else {
    return { ok: false, error: 'username or entityId is required', kind: 'target_required' };
  }
  if (!target) {
    return { ok: false, error: 'target not found', kind: 'target_missing' };
  }
  try {
    bot.attack(target);
    setCurrentTask(`attack ${username || entityId}`);
    recordAction('attack', username || `id=${entityId}`);
    emit('state', snapshot());
    return { ok: true, action: 'attack', target: username || entityId };
  } catch (err) {
    return { ok: false, error: err.message, kind: 'attack_failed' };
  }
}
