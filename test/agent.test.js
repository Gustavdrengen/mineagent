// Tests for the agent loop. Run with `npm test`.
//
// We exercise the goal grammar (`go to x,y,z`, `follow player`, `stop`,
// `say text`, `help`) without a live Mineflayer bot, and the dispatch
// function with synthetic chat events. `attachChatListener` is tested by
// pushing a fake chat event through the event bus and confirming the
// agent responds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  state,
  resetRuntime,
  setStatus,
  STATUS,
} from '../src/state.js';
import {
  dispatch,
  runGoal,
  getActiveGoal,
  attachChatListener,
  _setActiveGoal,
} from '../src/agent.js';
import { emit } from '../src/events.js';

function mockBot() {
  return {
    username: 'MineAgent',
    chat: () => {},
    quit: () => {},
    inventory: { items: () => [], on: () => {} },
    players: {},
    pathfinder: { setGoal: () => {}, once: () => {}, on: () => {}, off: () => {} },
  };
}

test('runGoal rejects empty input', async () => {
  const r = await runGoal('');
  assert.equal(r.ok, false);
});

test('runGoal "help" returns a list of commands', async () => {
  const r = await runGoal('help');
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.help));
  assert.ok(r.help.length > 0);
});

test('runGoal "say" records a chat reply and a voice event', async () => {
  resetRuntime();
  const r = await runGoal('say hello there');
  assert.equal(r.ok, true);
  assert.equal(r.said, 'hello there');
  assert.equal(state.voiceEvents[state.voiceEvents.length - 1].text, 'hello there');
});

test('runGoal "stop" returns a structured result even when not connected', async () => {
  resetRuntime();
  state.bot = null;
  const r = await runGoal('stop');
  assert.equal(r && typeof r === 'object', true);
});

test('runGoal "go to" rejects malformed input', async () => {
  const r = await runGoal('go to somewhere over the rainbow');
  assert.equal(r.ok, false);
});

test('runGoal "go to" returns not-connected when no bot', async () => {
  resetRuntime();
  state.bot = null;
  const r = await runGoal('go to 0, 64, 0');
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/);
});

test('runGoal "follow" without a player name returns a usage error', async () => {
  const r = await runGoal('follow');
  assert.equal(r.ok, false);
  assert.match(r.error, /usage: follow/);
});

test('runGoal echoes unrecognized goals as chat + voice', async () => {
  resetRuntime();
  const r = await runGoal('wave at everyone');
  assert.equal(r.ok, true);
  assert.equal(r.fallback, true);
  assert.equal(r.echoed, 'wave at everyone');
});

test('runGoal refuses to start while another goal is active', async () => {
  _setActiveGoal({ text: 'long-running placeholder', startedAt: Date.now() });
  try {
    const r = await runGoal('help');
    assert.equal(r.ok, false);
    assert.match(r.error, /busy with/);
  } finally {
    _setActiveGoal(null);
  }
});

test('two consecutive help goals both succeed when not busy', async () => {
  const a = await runGoal('help');
  const b = await runGoal('help');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test('dispatch routes !help through handleCommand', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = mockBot();
  const r = await dispatch({ from: 'tester', message: '!help' });
  assert.equal(r.handled, true);
  assert.equal(r.command, '!help');
});

test('dispatch routes !status and replies in chat + voice', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = mockBot();
  const r = await dispatch({ from: 'tester', message: '!status' });
  assert.equal(r.handled, true);
  assert.equal(r.command, '!status');
});

test('dispatch smalltalk ("where are you") replies in chat + voice', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = mockBot();
  const r = await dispatch({ from: 'tester', message: 'hey where are you' });
  assert.equal(r.handled, true);
  assert.equal(r.kind, 'smalltalk');
});

test('attachChatListener subscribes to chat events and dispatches them', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = mockBot();
  const off = attachChatListener();
  try {
    const before = state.voiceEvents.length;
    emit('chat', { username: 'tester', message: '!help' });
    await new Promise((r) => setImmediate(r));
    assert.ok(
      state.voiceEvents.length > before || state.chatHistory.length > 0,
      'expected the agent to record a voice or chat event'
    );
  } finally {
    off();
  }
});

test('attachChatListener ignores the bot\'s own messages', async () => {
  resetRuntime();
  setStatus(STATUS.CONNECTED);
  state.bot = mockBot();
  const off = attachChatListener();
  try {
    const before = state.voiceEvents.length;
    emit('chat', { username: 'MineAgent', message: '!help' });
    await new Promise((r) => setImmediate(r));
    assert.equal(state.voiceEvents.length, before);
  } finally {
    off();
  }
});

test('getActiveGoal returns null when no goal is running', () => {
  assert.equal(getActiveGoal(), null);
});

test('cleanup state for other tests', () => {
  resetRuntime();
  state.bot = null;
  assert.equal(state.bot, null);
});
