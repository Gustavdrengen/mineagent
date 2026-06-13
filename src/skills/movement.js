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

export async function moveToCoordinates({ x, y, z, tolerance = STOP_DISTANCE } = {}) {
  const bot = getBot();
  if (!bot || state.status !== 'connected') {
    return { ok: false, error: 'not connected' };
  }
  for (const v of [x, y, z]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, error: 'x, y, z must be finite numbers' };
    }
  }
  const pf = ensurePathfinder(bot);
  if (!pf) return { ok: false, error: 'pathfinder unavailable' };
  setCurrentTask(`move to ${x}, ${y}, ${z}`);
  recordAction('move', `to ${x}, ${y}, ${z}`);
  emit('state', null);
  const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
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
      finish({ ok: false, error: 'disconnected mid-path' })
    );
    const offKicked = subscribeTo(bot, 'kicked', (reason) =>
      finish({ ok: false, error: `kicked mid-path: ${reason || 'unknown'}` })
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
      if (result && result.status === 'noPath') {
        finish({ ok: false, error: 'no path found' });
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
    try {
      bot.pathfinder.setGoal(goal);
    } catch (err) {
      finish({ ok: false, error: err.message });
    }
  });
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
