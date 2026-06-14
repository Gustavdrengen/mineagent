// Chat skill for MineAgent.
//
// Reads the most recent chat line, responds in chat, and parses a small
// built-in command set so the agent loop can offload simple
// "what's around you?" / "follow me" type requests without reasoning about
// Mineflayer directly.

import { state, snapshot } from '../state.js';
import { emit, subscribe } from '../events.js';
import { sendChat } from '../connection.js';
import { status } from './status.js';

const BUILTIN_COMMANDS = {
  '!status': 'Report current position, health, food, and task.',
  '!inventory': 'Report inventory contents.',
  '!come': 'Walk to the player who sent the message.',
  '!stop': 'Stop any current movement.',
  '!look': 'Look in the direction the player is standing.',
  '!help': 'List built-in commands.',
};

function formatStatus(s) {
  if (!s || !s.connected) return 'I am not connected.';
  const parts = [];
  if (s.position) parts.push(`at ${s.position.x}, ${s.position.y}, ${s.position.z}`);
  if (s.health != null) parts.push(`health ${s.health}`);
  if (s.food != null) parts.push(`food ${s.food}/20`);
  if (s.currentTask) parts.push(`task: ${s.currentTask}`);
  return parts.length > 0 ? `I am ${parts.join(', ')}.` : 'I am idle.';
}

export function parseCommand(message) {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith('!')) return null;
  const [cmd, ...rest] = trimmed.split(/\s+/);
  return { name: cmd.toLowerCase(), args: rest };
}

// Default wait window for the persona's "wait for chat between turns"
// loop. The OpenCode persona calls `wait_for_chat` when it has nothing
// else to do; the timeout lets the loop return control to the harness
// on a bounded cadence instead of hanging on stdin. 10 seconds is long
// enough to feel "always listening" to a human in chat, short enough
// that OpenCode can resume its turn without an unbounded wait.
export const DEFAULT_WAIT_FOR_CHAT_TIMEOUT_MS = 10000;

// Clamp the wait window to a sensible range: at least 100ms (so a
// caller cannot construct a busy-loop), at most 60s (so a misbehaving
// caller cannot wedge the persona for a full minute per turn). 0 and
// negative values fall back to the default.
const WAIT_TIMEOUT_MIN_MS = 100;
const WAIT_TIMEOUT_MAX_MS = 60_000;

function clampWaitTimeout(timeoutMs, fallback) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(WAIT_TIMEOUT_MIN_MS, Math.min(WAIT_TIMEOUT_MAX_MS, n));
}

// Block until the next in-world chat message arrives from a player, or
// until `timeoutMs` has elapsed. This is the persona loop's "idle
// tick" — when the agent has nothing else to do, it calls the
// `wait_for_chat` MCP tool (which calls this helper) and uses the
// result to decide what to do next.
//
// The timeout is mandatory: the persona never wants to block
// indefinitely on a single MCP call. OpenCode treats very long
// tool-call waits as ambiguous, and a hung agent looks like a hung
// session. 10 seconds is the default; callers may pass a smaller or
// larger value, clamped to [100ms, 60s].
//
// The helper also subscribes to the connection-layer `end` event so a
// disconnect mid-wait returns immediately with the same `not_connected`
// envelope as a call made when the bot was already offline. That keeps
// the persona loop responsive: a `disconnect_from_server` (or a
// network drop) doesn't have to wait out the full 10-second window.
//
// Return shape:
//   - chat arrived:
//       { ok: true, from, message, ts }
//   - timeout:
//       { ok: false, timeout: true, error: 'no chat in window',
//         waitedMs }
//   - offline (now or during the wait):
//       { ok: false, error: 'not connected', kind: 'not_connected' }
export async function waitForChat({
  timeoutMs = DEFAULT_WAIT_FOR_CHAT_TIMEOUT_MS,
} = {}) {
  if (state.status !== 'connected') {
    return { ok: false, error: 'not connected', kind: 'not_connected' };
  }
  const safeTimeout = clampWaitTimeout(
    timeoutMs,
    DEFAULT_WAIT_FOR_CHAT_TIMEOUT_MS
  );
  const startedAt = Date.now();
  const cutoff = startedAt;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const off = subscribe((event, payload) => {
      if (settled) return;
      if (event === 'chat') {
        if (!payload) return;
        const ts = payload.ts || Date.now();
        if (ts < cutoff) return;
        settled = true;
        if (timer) clearTimeout(timer);
        off();
        resolve({
          ok: true,
          from: payload.username,
          message: payload.message,
          ts,
        });
        return;
      }
      // The bot dropped its connection while we were waiting. Surface
      // it the same way as a call made when the bot was already
      // offline so the persona loop can branch on one envelope shape.
      //
      // Only treat `disconnected` and `error` as terminal. `reconnecting`
      // and `connecting` are transient — the bot is in flight, not gone.
      // A 2-second reconnect blip must not short-circuit a wait that
      // is otherwise healthy.
      if (event === 'end' || event === 'status') {
        if (state.status === 'connected') return;
        if (state.status === 'reconnecting' || state.status === 'connecting') return;
        settled = true;
        if (timer) clearTimeout(timer);
        off();
        resolve({ ok: false, error: 'not connected', kind: 'not_connected' });
      }
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve({
        ok: false,
        timeout: true,
        error: 'no chat in window',
        waitedMs: Date.now() - startedAt,
      });
    }, safeTimeout);
  });
}

// Exposed for tests so the clamping band can be asserted directly
// without monkey-patching `global.setTimeout`. Production callers use
// `waitForChat`, which calls this internally. The `__test_` prefix is
// the project convention (see `connection.js`'s `__test_classifyKickReason`)
// that signals "test-only export — do not import from production code."
export function __test_clampWaitTimeout(timeoutMs, fallback) {
  return clampWaitTimeout(timeoutMs, fallback);
}

export function say({ message } = {}) {
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { ok: false, error: 'message is required', kind: 'message_required' };
  }
  const text = message.trim();
  // sendChat() in src/connection.js already records the 'chat' action
  // and broadcasts the voice event. The single in-world voice path:
  // convert the NotConnectedError throw into the same envelope the
  // tool wrapper would return, so callers never need a try/catch.
  // Unknown errors (no `kind` field) are re-thrown — they are
  // genuine bugs, not user-facing failures.
  try {
    sendChat(text);
  } catch (err) {
    if (err && err.kind) {
      return { ok: false, error: err.message, kind: err.kind };
    }
    throw err;
  }
  // State snapshot fires only on the success path. A failed send
  // doesn't change any state worth snapshotting.
  emit('state', snapshot());
  return { ok: true, message: text };
}

export async function handleCommand({ from, message, parsed: preParsed } = {}) {
  const parsed = preParsed || parseCommand(message);
  if (!parsed) {
    return { ok: true, handled: false, reason: 'not a command' };
  }
  // `say` is the single in-world voice: it routes through sendChat,
  // which auto-broadcasts a voice event to the browser observer for
  // TTS playback. The persona never needs a separate speak step.
  const reply = async (text) => {
    say({ message: text });
  };
  switch (parsed.name) {
    case '!help':
      await reply(
        'Commands: ' + Object.keys(BUILTIN_COMMANDS).join(', ')
      );
      return { ok: true, handled: true, command: '!help' };
    case '!status': {
      const s = status();
      await reply(formatStatus(s));
      return { ok: true, handled: true, command: '!status' };
    }
    case '!inventory': {
      const s = status({ include: ['inventory'] });
      const items =
        s.inventory && s.inventory.length > 0
          ? s.inventory.map((i) => `${i.count}x ${i.name}`).join(', ')
          : 'empty';
      await reply(`Inventory: ${items}`);
      return { ok: true, handled: true, command: '!inventory' };
    }
    case '!stop': {
      const { stopMoving } = await import('./movement.js');
      const r = stopMoving();
      if (r.ok) await reply('Stopped.');
      else await reply(`Could not stop: ${r.error}`);
      return { ok: true, handled: true, command: '!stop' };
    }
    case '!come': {
      const player = parsed.args[0] || from;
      if (!player) {
        await reply('Usage: !come <player>');
        return { ok: true, handled: true, command: '!come' };
      }
      const { followPlayer } = await import('./movement.js');
      // Fire and forget — following is long-running.
      followPlayer({ username: player, durationMs: 60000 }).catch(() => {});
      await reply(`Following ${player}.`);
      return { ok: true, handled: true, command: '!come' };
    }
    case '!look': {
      // Look toward the requesting player if we can find them.
      const bot = state.bot;
      if (!bot) return { ok: false, error: 'not connected' };
      const target = from ? bot.players[from]?.entity : null;
      if (!target || !target.position || !bot.entity?.position) {
        await reply("I can't see you right now.");
        return { ok: true, handled: true, command: '!look' };
      }
      try {
        await bot.lookAt(target.position);
        await reply('Looking at you.');
      } catch (err) {
        await reply(`Look failed: ${err.message}`);
      }
      return { ok: true, handled: true, command: '!look' };
    }
    default:
      return { ok: true, handled: false, reason: 'unknown command' };
  }
}

export const builtins = BUILTIN_COMMANDS;
