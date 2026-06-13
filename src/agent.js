// Agent loop for MineAgent.
//
// The loop is intentionally simple: it does not include an LLM. Instead,
// it dispatches chat commands (the built-in `!` set) and exposes a
// `runGoal` function the entry point uses to drive a user-provided goal
// from stdin. Both paths go through the same `dispatch` function so the
// CLI goal input and the in-game chat behave identically.

import { emit, subscribe } from './events.js';
import { state } from './state.js';
import { handleCommand, parseCommand, say } from './skills/chat.js';
import { status } from './skills/status.js';
import { moveToCoordinates, followPlayer, stopMoving } from './skills/movement.js';
import { mineBlock, placeBlock, lookAtBlock } from './skills/world-interaction.js';
import { createSkill, createScript, writeMemory } from './improve.js';

let running = false;
let activeGoal = null;

function isBusy() {
  return Boolean(activeGoal);
}

function describeGoal(goal) {
  if (!goal) return 'no active goal';
  return goal.summary || goal.text || JSON.stringify(goal);
}

function recordChatReply(text) {
  // Mirror a reply into state.chatHistory so the observer picks it up.
  say({ message: text });
}

export async function dispatch({ from, message }) {
  if (!message) return { ok: true, handled: false };
  const parsed = parseCommand(message);
  if (!parsed) {
    // Treat any non-`!` line addressed to the bot as a small-talk question.
    if (!from) return { ok: true, handled: false };
    const lower = String(message).toLowerCase();
    if (lower.includes('where are you') || lower.includes('status')) {
      const s = status();
      const text =
        s.connected && s.position
          ? `I am at ${s.position.x}, ${s.position.y}, ${s.position.z}.`
          : 'I am not connected to a server right now.';
      recordChatReply(text);
      return { ok: true, handled: true, kind: 'smalltalk', reply: text };
    }
    return { ok: true, handled: false };
  }
  return handleCommand({ from, message, parsed });
}

export function attachChatListener() {
  return subscribe(async (event, payload) => {
    if (event !== 'chat') return;
    if (!payload) return;
    if (state.status !== 'connected') return;
    if (state.bot && payload.username === state.bot.username) return;
    try {
      await dispatch({ from: payload.username, message: payload.message });
    } catch (err) {
      // The error reporter can itself fail (say() re-throws unknown
      // errors, the bot may be mid-disconnect). Wrap the reporter in
      // its own try/catch so a double-fault doesn't escape silently
      // from the event subscriber.
      try {
        say({ message: `I hit an error: ${err.message}` });
      } catch (reporterErr) {
        console.error('[agent] error reporter failed:', reporterErr.message);
      }
    }
  });
}

// Goal runner: a tiny, deterministic command dispatcher that maps a
// `goal` string to a sequence of tool/skill calls. The grammar is:
//   "connect <host>[:<port>]"
//   "go to <x>, <y>, <z>"
//   "follow <player>"
//   "stop"
//   "mine <count> <block>"
//   "place <block>"
//   "say <text>"
//   "remember <text>" / "write memory <text>"
//   "create skill <name> <body>"
//   "create script <name> <body>"
//   anything else → echoed in chat
export async function runGoal(goal) {
  if (!goal || typeof goal !== 'string') {
    return { ok: false, error: 'goal must be a string' };
  }
  if (isBusy()) {
    return { ok: false, error: `busy with: ${describeGoal(activeGoal)}` };
  }
  activeGoal = { text: goal, startedAt: Date.now() };
  emit('goal', { status: 'started', goal });
  try {
    const result = await runGoalInternal(goal);
    activeGoal = null;
    emit('goal', { status: 'done', goal, result });
    return result;
  } catch (err) {
    activeGoal = null;
    emit('goal', { status: 'error', goal, error: err.message });
    return { ok: false, error: err.message };
  }
}

async function runGoalInternal(goal) {
  const text = goal.trim();
  const lower = text.toLowerCase();

  if (lower.startsWith('go to ')) {
    const m = text.match(/go to\s+(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i);
    if (!m) return { ok: false, error: 'usage: go to x, y, z' };
    const [, x, y, z] = m;
    return moveToCoordinates({ x: Number(x), y: Number(y), z: Number(z) });
  }
  if (lower === 'follow' || lower.startsWith('follow ')) {
    const m = text.match(/^follow(?:\s+(\S+))?$/i);
    if (!m || !m[1]) return { ok: false, error: 'usage: follow <player>' };
    return followPlayer({ username: m[1] });
  }
  if (lower === 'stop') {
    return stopMoving();
  }
  if (lower.startsWith('mine ')) {
    const m = text.match(/mine\s+(\d+)\s+(\S+)/i);
    if (!m) return { ok: false, error: 'usage: mine <count> <block>' };
    return mineBlock({ count: Number(m[1]), name: m[2] });
  }
  if (lower.startsWith('look at ')) {
    const m = text.match(/look at\s+(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i);
    if (!m) return { ok: false, error: 'usage: look at x, y, z' };
    const [, x, y, z] = m;
    return lookAtBlock({ position: { x: Number(x), y: Number(y), z: Number(z) } });
  }
  if (lower.startsWith('say ')) {
    const reply = text.slice(4);
    recordChatReply(reply);
    return { ok: true, said: reply };
  }
  if (lower.startsWith('remember ')) {
    const body = text.slice('remember '.length);
    return writeMemory({ name: `note-${Date.now()}`, body });
  }
  if (lower.startsWith('create skill ')) {
    const m = text.match(/create skill\s+(\S+)\s+([\s\S]+)$/i);
    if (!m) return { ok: false, error: 'usage: create skill <name> <body>' };
    return createSkill({ name: m[1], body: m[2], kind: 'code' });
  }
  if (lower.startsWith('create script ')) {
    const m = text.match(/create script\s+(\S+)\s+([\s\S]+)$/i);
    if (!m) return { ok: false, error: 'usage: create script <name> <body>' };
    return createScript({ name: m[1], body: m[2] });
  }
  if (lower === 'help' || lower === '?') {
    return {
      ok: true,
      help: [
        'go to x, y, z',
        'follow <player>',
        'stop',
        'mine <count> <block>',
        'look at x, y, z',
        'say <text>',
        'remember <text>',
        'create skill <name> <body>',
        'create script <name> <body>',
      ],
    };
  }
  // Fallback: echo the goal as a chat line. TTS is an automatic side
  // effect of sendChat, so the agent does not need to call anything
  // else.
  recordChatReply(goal);
  return { ok: true, fallback: true, echoed: goal };
}

export function isRunning() {
  return running;
}

export function setRunning(value) {
  running = Boolean(value);
}

export function getActiveGoal() {
  return activeGoal;
}

// Test-only helper. Production code should not need to mutate the active
// goal; runGoal sets and clears it on its own. Exported for tests that
// need to assert the busy-state guard.
export function _setActiveGoal(goal) {
  activeGoal = goal || null;
}
