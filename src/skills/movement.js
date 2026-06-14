// Movement skill for MineAgent.
//
// Walks the bot to a target destination, follows a named player, or stops
// the current movement. The skill is intentionally small and synchronous
// from the caller's perspective: it returns a promise that resolves when
// the bot arrives, gets close enough, fails to find a path, or is asked
// to stop. Callers (the agent loop, the skills loader) are expected to
// surface failures through the agent's own reporting layer.

import pathfinder from 'mineflayer-pathfinder';
import { state, setCurrentTask, recordAction } from '../state.js';
import { emit } from '../events.js';

const { goals, Movements } = pathfinder;
const STOP_DISTANCE = 1; // blocks
// Default cap on a single move. Without a timeout, a stuck-but-not-
// noPath destination would block the persona loop forever. 30s is
// long enough for normal cross-biome walks and short enough that an
// unreachable goal returns control to the persona within one chat
// exchange.
const DEFAULT_MOVE_TIMEOUT_MS = 30000;
// Block id 0 is air. Anything else is treated as "solid for the
// purposes of standing on it" — true solids like logs and stone
// obviously, but also slabs, fences, etc. The point is to detect
// "the destination is occupied", not to do a full collision query.
const AIR_BLOCK_ID = 0;

// Module-level handle for the active follow interval so stopMoving()
// can actually cancel a follow (previously the tick would re-issue
// setGoal after stopMoving cleared the pathfinder goal).
let activeFollowTimer = null;

function ensurePathfinder(bot) {
  if (!bot) return null;
  if (bot.pathfinder) return bot.pathfinder;
  bot.loadPlugin(pathfinder.pathfinder);
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  return bot.pathfinder;
}

function getBot() {
  return state.bot;
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function subscribeTo(emitter, event, fn, once = false) {
  if (!emitter || typeof emitter.on !== 'function') return () => {};
  if (once) emitter.once(event, fn);
  else emitter.on(event, fn);
  return () => {
    if (typeof emitter.off === 'function') emitter.off(event, fn);
    else if (typeof emitter.removeListener === 'function')
      emitter.removeListener(event, fn);
  };
}

// Inspect the block at a position and decide whether the bot can stand
// on it. Returns `true` for air, unknown chunks, and any block that is
// not solid in the obvious sense. The check is deliberately a small
// surface area (blockAt + type != 0) because the cost is paid on every
// move, and the goal-selection fork in `moveToCoordinates` is the
// only consumer. We prefer `bot.Vec3` when available because the real
// Mineflayer `blockAt` is strict about Vec3-shaped input; passing a
// plain object would silently throw on a real bot and trigger the
// GoalBlock branch — which is the bug this helper exists to prevent.
function isDestinationSolid(bot, x, y, z) {
  if (typeof bot.blockAt !== 'function') return false;
  const Vec3Ctor = bot.Vec3;
  const probe = typeof Vec3Ctor === 'function' ? new Vec3Ctor(x, y, z) : { x, y, z };
  let block;
  try {
    block = bot.blockAt(probe);
  } catch {
    return false;
  }
  if (!block) return false;
  return block.type !== AIR_BLOCK_ID;
}

export async function moveToCoordinates({
  x,
  y,
  z,
  tolerance = STOP_DISTANCE,
  timeoutMs = DEFAULT_MOVE_TIMEOUT_MS,
} = {}) {
  const bot = getBot();
  if (!bot || state.status !== 'connected') {
    return { ok: false, error: 'not connected', kind: 'not_connected' };
  }
  for (const v of [x, y, z]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, error: 'x, y, z must be finite numbers', kind: 'coords_invalid' };
    }
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return { ok: false, error: 'timeoutMs must be a non-negative number', kind: 'timeout_invalid' };
  }
  const pf = ensurePathfinder(bot);
  if (!pf) return { ok: false, error: 'pathfinder unavailable', kind: 'no_pathfinder' };
  setCurrentTask(`move to ${x}, ${y}, ${z}`);
  recordAction('move', `to ${x}, ${y}, ${z}`);
  emit('state', null);
  const goalX = Math.floor(x);
  const goalY = Math.floor(y);
  const goalZ = Math.floor(z);
  // Pick the goal type based on what's at the destination. If the
  // destination is occupied by a solid block (a tree, a wall, a placed
  // block), a strict GoalBlock would either fail to find a path or
  // find a partial path that puts the bot up against the block with
  // no way to call it done. GoalNear lets the pathfinder settle as
  // soon as the bot is within `tolerance` blocks of the destination,
  // which is the right behavior for the common "go to this tree" /
  // "go to this ore" case. Air destinations keep the exact GoalBlock
  // so callers that rely on the bot being at a specific coordinate
  // (e.g. placing a block at an exact spot) still get exact
  // positioning.
  const destinationIsSolid = isDestinationSolid(bot, goalX, goalY, goalZ);
  const goal = destinationIsSolid
    ? new goals.GoalNear(goalX, goalY, goalZ, tolerance)
    : new goals.GoalBlock(goalX, goalY, goalZ);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimer();
      try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
      offEnd();
      offKicked();
      setCurrentTask('idle');
      emit('state', null);
      resolve(result);
    };
    // If the bot disconnects mid-path, the pathfinder listeners will
    // never fire and this promise would hang forever. Subscribe to the
    // Mineflayer end/kicked events and resolve the movement.
    const offEnd = subscribeTo(bot, 'end', () =>
      finish({ ok: false, error: 'disconnected mid-path', kind: 'not_connected' })
    );
    const offKicked = subscribeTo(bot, 'kicked', (reason) =>
      finish({ ok: false, error: `kicked mid-path: ${reason || 'unknown'}`, kind: 'kicked' })
    );
    subscribeTo(bot.pathfinder, 'goal_reached', () => {
      const arrived = bot.entity?.position
        ? {
            x: Math.floor(bot.entity.position.x),
            y: Math.floor(bot.entity.position.y),
            z: Math.floor(bot.entity.position.z),
          }
        : null;
      finish({ ok: true, arrivedAt: arrived, pathLength: arrived ? 1 : 0 });
    }, true);
    subscribeTo(bot.pathfinder, 'path_update', (result) => {
      if (!result) return;
      if (result.status === 'noPath') {
        finish({ ok: false, error: 'no path found', kind: 'no_path' });
      } else if (result.status === 'partialPath') {
        // A partial path means the pathfinder found *some* route but
        // it does not reach the goal. Without handling this, the bot
        // would walk as far as it can and then idle in place, never
        // emitting goal_reached or noPath. The persona would never
        // get a result back. This is the tree-in-the-way scenario:
        // surface it as a structured error so the agent can decide
        // (e.g. call move_to to an adjacent position, mine the
        // obstacle, or ask the user for guidance).
        finish({
          ok: false,
          error: 'partial path: destination is not reachable from here',
          kind: 'destination_blocked',
        });
      }
    }, true);
    subscribeTo(bot.pathfinder, 'goal_updated', () => {
      if (
        bot.entity &&
        distance(bot.entity.position, { x, y, z }) <= tolerance
      ) {
        finish({ ok: true, arrivedAt: { x, y, z }, pathLength: 0 });
      }
    }, true);
    // Hard cap. Without this, a bot that gets stuck against an
    // obstacle (pathfinder keeps trying, no error event) would block
    // the persona loop forever. 0 means "no timeout" — the persona
    // can opt out for long-distance moves if it wants to. We unref
    // the timer so a pending move does not keep the test process
    // alive past its natural end; in production the Mineflayer
    // socket is the loop's real anchor.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({
          ok: false,
          error: `did not reach destination within ${timeoutMs}ms`,
          kind: 'timeout',
        });
      }, timeoutMs);
    }
    try {
      bot.pathfinder.setGoal(goal);
    } catch (err) {
      finish({ ok: false, error: err.message, kind: 'path_error' });
    }
  });
}

export async function followPlayer({ username, durationMs = 30000 } = {}) {
  const bot = getBot();
  if (!bot || state.status !== 'connected') {
    return { ok: false, error: 'not connected' };
  }
  if (!username) return { ok: false, error: 'username is required' };
  // If a previous follow is still running, cancel it before starting a
  // new one so we do not leak two timers racing on the same pathfinder.
  if (activeFollowTimer) {
    clearInterval(activeFollowTimer);
    activeFollowTimer = null;
  }
  setCurrentTask(`follow ${username}`);
  recordAction('follow', username);
  emit('state', null);
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() - start >= durationMs) {
        clearInterval(activeFollowTimer);
        activeFollowTimer = null;
        try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
        setCurrentTask('idle');
        emit('state', null);
        resolve({ ok: true, stopped: true, reason: 'duration reached' });
        return;
      }
      const target = bot.players[username]?.entity;
      if (!target || !target.position) return;
      const goal = new goals.GoalFollow(target, 1);
      try {
        bot.pathfinder.setGoal(goal, true);
      } catch {
        // ignore intermittent failures; we will retry next tick
      }
    };
    activeFollowTimer = setInterval(tick, 500);
    tick();
  });
}

export function stopMoving() {
  const bot = getBot();
  if (activeFollowTimer) {
    clearInterval(activeFollowTimer);
    activeFollowTimer = null;
  }
  if (!bot) return { ok: false, error: 'not connected' };
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    // ignore
  }
  setCurrentTask('idle');
  emit('state', null);
  return { ok: true };
}
