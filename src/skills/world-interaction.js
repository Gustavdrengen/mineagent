// World-interaction skill for MineAgent.
//
// Looks at a block, mines a block by name, and places a block from the
// bot's inventory. Each action returns a small structured result. Mining
// and placing update the shared inventory cache so the observer reflects
// the change immediately.

import { state, setInventory, recordAction, setCurrentTask, snapshot } from '../state.js';
import { emit } from '../events.js';

function getBot() {
  return state.bot;
}

function collectInventory(bot) {
  if (!bot || !bot.inventory) return [];
  const items = bot.inventory.items
    ? bot.inventory.items()
    : Array.from(bot.inventory.slots || []).filter(Boolean);
  return items.map((item, idx) => ({
    slot: item.slot ?? idx,
    name: item.name,
    count: item.count,
  }));
}

function refreshInventory(bot) {
  if (!bot) return;
  try {
    setInventory(collectInventory(bot));
  } catch {
    // ignore inventory collection errors
  }
  emit('state', snapshot());
}

function findBlockId(bot, name) {
  if (!bot || !bot.registry || !bot.registry.blocksByName) return null;
  return bot.registry.blocksByName[name]?.id ?? null;
}

export async function lookAtBlock({ position } = {}) {
  const bot = getBot();
  if (!bot || state.status !== 'connected') {
    return { ok: false, error: 'not connected' };
  }
  if (!position) return { ok: false, error: 'position is required' };
  try {
    await bot.lookAt(position);
    const block = bot.blockAt(position);
    recordAction('look', `${position.x},${position.y},${position.z}`);
    emit('state', snapshot());
    return { ok: true, block: block ? { name: block.name, position } : null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function mineBlock({ name, count = 1, range = 4 } = {}) {
  const bot = getBot();
  if (!bot || state.status !== 'connected') {
    return { ok: false, error: 'not connected' };
  }
  if (!name) return { ok: false, error: 'name is required' };
  if (typeof count !== 'number' || count < 1) {
    return { ok: false, error: 'count must be a positive number' };
  }
  const id = findBlockId(bot, name);
  if (id == null) {
    return { ok: false, error: `unknown block: ${name}` };
  }
  if (!bot.entity) {
    return { ok: false, error: 'bot is not in a world yet' };
  }
  setCurrentTask(`mine ${count} ${name}`);
  recordAction('mine', `${count} ${name}`);
  emit('state', snapshot());

  let mined = 0;
  for (let attempt = 0; attempt < count * 4 && mined < count; attempt++) {
    const target = bot.findBlock({ matching: id, maxDistance: range });
    if (!target) {
      if (mined === 0) {
        setCurrentTask('idle');
        return { ok: false, error: `no ${name} in range ${range}` };
      }
      break;
    }
    try {
      await bot.dig(target);
      mined++;
    } catch (err) {
      setCurrentTask('idle');
      return { ok: false, error: err.message, blocksTouched: mined };
    }
  }
  setCurrentTask('idle');
  refreshInventory(bot);
  return { ok: true, action: 'mine', blocksTouched: mined };
}

export async function placeBlock({ name, position, faceVector } = {}) {
  const bot = getBot();
  if (!bot || state.status !== 'connected') {
    return { ok: false, error: 'not connected' };
  }
  if (!name) return { ok: false, error: 'name is required' };
  if (!position) return { ok: false, error: 'position is required' };
  const Vec3 = bot.Vec3;
  if (!Vec3) return { ok: false, error: 'Vec3 not available on bot' };
  const item = bot.inventory.items().find((i) => i.name === name);
  if (!item) {
    return { ok: false, error: `no ${name} in inventory` };
  }
  const face = faceVector
    ? new Vec3(faceVector.x | 0, faceVector.y | 0, faceVector.z | 0)
    : new Vec3(0, 1, 0);
  try {
    await bot.equip(item, 'hand');
    await bot.placeBlock(position, face);
    setCurrentTask('idle');
    recordAction('place', `${name} at ${position.x},${position.y},${position.z}`);
    refreshInventory(bot);
    return { ok: true, action: 'place', position };
  } catch (err) {
    setCurrentTask('idle');
    return { ok: false, error: err.message };
  }
}
