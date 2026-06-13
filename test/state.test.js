// Tests for the shared state machine. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  state,
  STATUS,
  snapshot,
  setStatus,
  setPosition,
  setHealth,
  setInventory,
  setCurrentTask,
  recordChat,
  recordVoice,
  recordAction,
  resetRuntime,
  markSessionStart,
} from '../src/state.js';

test('STATUS is frozen and contains the five vision states', () => {
  assert.equal(typeof STATUS, 'object');
  assert.ok(Object.isFrozen(STATUS));
  for (const k of [
    'DISCONNECTED',
    'CONNECTING',
    'CONNECTED',
    'RECONNECTING',
    'ERROR',
  ]) {
    assert.ok(k in STATUS);
  }
});

test('snapshot returns the expected shape', () => {
  const s = snapshot();
  for (const k of [
    'status',
    'host',
    'port',
    'username',
    'lastError',
    'position',
    'health',
    'inventory',
    'currentTask',
    'chatHistory',
    'voiceEvents',
    'recentActions',
    'session',
  ]) {
    assert.ok(k in s, `missing key: ${k}`);
  }
});

test('setStatus updates status and lastError', () => {
  const original = state.status;
  try {
    setStatus(STATUS.CONNECTED, null);
    assert.equal(state.status, STATUS.CONNECTED);
    setStatus(STATUS.ERROR, 'oops');
    assert.equal(state.status, STATUS.ERROR);
    assert.equal(state.lastError, 'oops');
  } finally {
    setStatus(original);
  }
});

test('setPosition floors coordinates', () => {
  setPosition({ x: 1.7, y: 64.1, z: -2.9 });
  assert.equal(state.position.x, 1);
  assert.equal(state.position.y, 64);
  assert.equal(state.position.z, -3);
});

test('setHealth accepts a Mineflayer health object', () => {
  setHealth({ health: 18, food: 14 });
  assert.equal(state.health.current, 18);
  assert.equal(state.health.food, 14);
});

test('setInventory replaces the inventory list', () => {
  setInventory([{ slot: 0, name: 'oak_log', count: 3 }]);
  assert.equal(state.inventory.length, 1);
  assert.equal(state.inventory[0].name, 'oak_log');
});

test('setCurrentTask sets and clears', () => {
  setCurrentTask('mining');
  assert.equal(state.currentTask, 'mining');
  setCurrentTask(null);
  assert.equal(state.currentTask, null);
});

test('recordChat/recordVoice/recordAction bound the history', () => {
  resetRuntime();
  for (let i = 0; i < 200; i++) recordChat('tester', `hi ${i}`);
  assert.ok(state.chatHistory.length <= 100);
  assert.equal(state.chatHistory[state.chatHistory.length - 1].message, 'hi 199');

  for (let i = 0; i < 100; i++) recordVoice(`v ${i}`);
  assert.ok(state.voiceEvents.length <= 50);
  assert.equal(state.voiceEvents[state.voiceEvents.length - 1].text, 'v 99');

  for (let i = 0; i < 100; i++) recordAction('act', `d ${i}`);
  assert.ok(state.recentActions.length <= 50);
});

test('markSessionStart sets a numeric startedAt', () => {
  markSessionStart();
  assert.equal(typeof state.session.startedAt, 'number');
  assert.ok(state.session.startedAt > 0);
});

test('resetRuntime clears runtime state but keeps config', () => {
  setCurrentTask('busy');
  setInventory([{ slot: 0, name: 'dirt', count: 1 }]);
  resetRuntime();
  assert.equal(state.currentTask, null);
  assert.equal(state.inventory.length, 0);
  assert.equal(typeof state.config.username, 'string');
});
