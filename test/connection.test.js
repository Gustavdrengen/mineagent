// Tests for the connection tool registry. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools, findTool } from '../src/tools/index.js';
import { state, STATUS } from '../src/state.js';

const REQUIRED_TOOLS = [
  'connect_to_server',
  'disconnect_from_server',
  'set_username',
  'connection_status',
  'ask_user_for_server',
];

test('all five vision-mandated connection tools are registered', () => {
  const names = tools.map((t) => t.name);
  for (const required of REQUIRED_TOOLS) {
    assert.ok(names.includes(required), `missing tool: ${required}`);
  }
});

test('every tool has a name, description, parameters, and execute function', () => {
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(typeof tool.parameters, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
});

test('findTool returns the matching tool or null', () => {
  assert.ok(findTool('connect_to_server'));
  assert.equal(findTool('does_not_exist'), null);
});

test('connection_status returns ok=true with a known status', async () => {
  const tool = findTool('connection_status');
  const result = await tool.execute({});
  assert.equal(result.ok, true);
  assert.ok(Object.values(STATUS).includes(result.status));
  assert.equal(typeof result.username, 'string');
});

test('set_username updates the configured username', async () => {
  const tool = findTool('set_username');
  const original = state.config.username;
  try {
    const result = await tool.execute({ username: 'TestBot' });
    assert.equal(result.ok, true);
    assert.equal(state.config.username, 'TestBot');
  } finally {
    state.config.username = original;
  }
});

test('set_username rejects an empty username', async () => {
  const tool = findTool('set_username');
  const result = await tool.execute({ username: '' });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('ask_user_for_server returns a prompt', async () => {
  const tool = findTool('ask_user_for_server');
  const result = await tool.execute({});
  assert.equal(result.ok, true);
  assert.equal(typeof result.prompt, 'string');
  assert.ok(result.prompt.length > 0);
});
