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

export async function listenChat({ durationMs = 0, after = null } = {}) {
  // Returns the next chat message addressed to anyone. If `durationMs` is
  // 0, waits for the next message; otherwise resolves after that timeout
  // with a `timeout: true` result.
  const cutoff =
    typeof after === 'number' && Number.isFinite(after) ? after : Date.now();
  if (state.status !== 'connected') {
    return { ok: false, error: 'not connected' };
  }
  return new Promise((resolve) => {
    let timer = null;
    const off = subscribe((event, payload) => {
      if (event !== 'chat') return;
      if (!payload) return;
      const ts = payload.ts || Date.now();
      if (ts < cutoff) return;
      if (timer) clearTimeout(timer);
      off();
      resolve({ ok: true, from: payload.username, message: payload.message, ts });
    });
    if (durationMs > 0) {
      timer = setTimeout(() => {
        off();
        resolve({ ok: false, timeout: true, error: 'no chat in window' });
      }, durationMs);
    }
  });
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
