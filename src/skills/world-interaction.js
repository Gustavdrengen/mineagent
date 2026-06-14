// World-interaction skill for MineAgent.
//
// Looks at a block, mines a block by name, and places a block from the
// bot's inventory. Each action returns a small structured result. Mining
// and placing update the shared inventory cache so the observer reflects
// the change immediately.

import { state, setInventory, recordAction, setCurrentTask, snapshot } from '../state.js';
import { emit } from '../events.js';

// Mining reach in survival mode. Mineflayer's `dig` throws if the
// target is further than this from the bot; we treat the same threshold
// as "out of reach" before calling dig so the tool can pick a closer
// block and surface a structured error instead of a generic
// "Player position is too far" message. Squared to avoid a sqrt on
// every candidate.
const MINING_REACH = 4.5;
const MINING_REACH_SQ = MINING_REACH * MINING_REACH;

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

// Distance squared between two positions. Returns Infinity if either
// input is missing, so the caller's "<= threshold" check naturally
// rejects incomplete inputs.
function distanceSq(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

// Is the candidate block close enough to dig? Mineflayer's `dig` throws
// "Player position is too far" for blocks past the survival reach, but
// we want to detect the same condition proactively so the tool can
// pick a closer candidate instead of bubbling the raw message up.
function isWithinReach(bot, block) {
  if (!bot?.entity?.position || !block?.position) return false;
  return distanceSq(bot.entity.position, block.position) <= MINING_REACH_SQ;
}

// Is the candidate block diggable? `bot.canDigBlock` (when present)
// returns false for bedrock, water, lava, etc. We treat "cannot dig"
// as a hard skip: there is no point retrying the same block on the
// next attempt — it is structurally undiggable.
function isDiggable(bot, block) {
  if (typeof bot.canDigBlock !== 'function') return true;
  return bot.canDigBlock(block);
}

export async function mineBlock({ name, count = 1, range = 4 } = {}) {
  const bot = getBot();
  if (!bot || state.status !== 'connected') {
    return { ok: false, error: 'not connected', kind: 'not_connected' };
  }
  if (!name) return { ok: false, error: 'name is required', kind: 'name_required' };
  if (typeof count !== 'number' || count < 1) {
    return { ok: false, error: 'count must be a positive number', kind: 'count_invalid' };
  }
  const id = findBlockId(bot, name);
  if (id == null) {
    return { ok: false, error: `unknown block: ${name}`, kind: 'unknown_block' };
  }
  if (!bot.entity) {
    return { ok: false, error: 'bot is not in a world yet', kind: 'no_position' };
  }
  setCurrentTask(`mine ${count} ${name}`);
  recordAction('mine', `${count} ${name}`);
  emit('state', snapshot());

  let mined = 0;
  // Track the last block we skipped and why, so we can surface a
  // useful error (with position) when no candidate was reachable.
  let lastSkipped = null;
  const maxAttempts = count * 4;

  for (let attempt = 0; attempt < maxAttempts && mined < count; attempt++) {
    const candidate = bot.findBlock({ matching: id, maxDistance: range });
    if (!candidate) {
      if (mined === 0) {
        setCurrentTask('idle');
        return { ok: false, error: `no ${name} in range ${range}`, kind: 'no_block_in_range' };
      }
      break;
    }
    // Re-resolve the block at the candidate's position: the world may
    // have shifted between findBlock and now (the bot just mined a
    // neighbour, a chunk loaded, etc.), and the candidate's cached
    // `type` may be stale. If the block is gone or no longer matches,
    // try the next candidate.
    const current = typeof bot.blockAt === 'function'
      ? bot.blockAt(candidate.position)
      : candidate;
    if (!current || current.type !== candidate.type) {
      continue;
    }
    if (!isWithinReach(bot, current)) {
      lastSkipped = {
        position: {
          x: current.position.x,
          y: current.position.y,
          z: current.position.z,
        },
        kind: 'out_of_reach',
      };
      continue;
    }
    if (!isDiggable(bot, current)) {
      lastSkipped = {
        position: {
          x: current.position.x,
          y: current.position.y,
          z: current.position.z,
        },
        kind: 'not_diggable',
      };
      continue;
    }
    try {
      // Force the bot to look at the target before swinging. Without
      // this, the dig animation can play against whatever block the
      // bot happens to be facing, and the actual target never breaks.
      // The persona has no way to know it should look first — the tool
      // has to.
      if (typeof bot.lookAt === 'function') {
        await bot.lookAt(current.position, true);
      }
      await bot.dig(current);
      mined++;
    } catch (err) {
      setCurrentTask('idle');
      return {
        ok: false,
        error: err.message,
        blocksTouched: mined,
        kind: 'dig_failed',
      };
    }
  }

  setCurrentTask('idle');
  refreshInventory(bot);

  if (mined === 0 && lastSkipped) {
    // We found blocks, but none of them were reachable / diggable.
    // Tell the persona where the nearest one is, so it can move the
    // bot closer (or pick a different block) on the next turn.
    const { position, kind } = lastSkipped;
    const reason = kind === 'out_of_reach'
      ? `out of reach (nearest ${name} is at ${position.x}, ${position.y}, ${position.z}; get within ${MINING_REACH} blocks first)`
      : `not diggable (nearest ${name} at ${position.x}, ${position.y}, ${position.z} cannot be broken)`;
    return {
      ok: false,
      error: reason,
      kind,
      position,
      nearest: { name, position },
    };
  }
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
