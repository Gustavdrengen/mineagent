// Tests for the in-process event bus. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, emit, clear } from '../src/events.js';

test('subscribe + emit delivers a payload to the listener', () => {
  const received = [];
  const off = subscribe((event, payload) => received.push({ event, payload }));
  emit('chat', { username: 'tester', message: 'hi' });
  off();
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'chat');
  assert.equal(received[0].payload.username, 'tester');
});

test('off() stops delivery', () => {
  const received = [];
  const off = subscribe((event, payload) => received.push(payload));
  emit('x', 1);
  off();
  emit('x', 2);
  assert.equal(received.length, 1);
  assert.equal(received[0], 1);
});

test('a listener that throws does not break the rest', () => {
  const received = [];
  subscribe(() => { throw new Error('boom'); });
  subscribe((event, payload) => received.push(payload));
  emit('test', 42);
  assert.equal(received.length, 1);
  assert.equal(received[0], 42);
});

test('clear removes every listener', () => {
  const received = [];
  subscribe((e, p) => received.push(p));
  clear();
  emit('test', 1);
  assert.equal(received.length, 0);
});
