// Tests for the self-improvement helpers. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSkill,
  createScript,
  writeMemory,
  listSkills,
  listScripts,
  listMemories,
  paths,
} from '../src/improve.js';

test('createSkill writes a markdown file by default', () => {
  const r = createSkill({ name: 'unit-test-skill', body: '# test\n' });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(r.path));
  assert.ok(r.path.endsWith('.md'));
  fs.unlinkSync(r.path);
});

test('createSkill(kind=code) writes a .js file', () => {
  const r = createSkill({ name: 'unit-test-skill-code', body: '// skill\n', kind: 'code' });
  assert.equal(r.ok, true);
  assert.ok(r.path.endsWith('.js'));
  fs.unlinkSync(r.path);
});

test('createSkill rejects unsafe names', () => {
  const r = createSkill({ name: '../etc/passwd', body: 'x' });
  assert.equal(r.ok, false);
});

test('createSkill rejects empty body', () => {
  const r = createSkill({ name: 'unit-test-empty', body: '' });
  assert.equal(r.ok, false);
});

test('createScript writes a .js file', () => {
  const r = createScript({ name: 'unit-test-script', body: '// script\n' });
  assert.equal(r.ok, true);
  assert.ok(r.path.endsWith('.js'));
  fs.unlinkSync(r.path);
});

test('writeMemory writes a .md file into memories/', () => {
  const r = writeMemory({ name: 'unit-test-memo', body: 'remembered\n' });
  assert.equal(r.ok, true);
  assert.ok(r.path.startsWith(paths.memoriesDir));
  fs.unlinkSync(r.path);
});

test('list functions return arrays of paths', () => {
  const s = createSkill({ name: 'unit-test-list-skill', body: 'x' });
  const sc = createScript({ name: 'unit-test-list-script', body: 'y' });
  const m = writeMemory({ name: 'unit-test-list-memo', body: 'z' });
  try {
    const skills = listSkills();
    const scripts = listScripts();
    const mems = listMemories();
    assert.ok(skills.includes(s.path));
    assert.ok(scripts.includes(sc.path));
    assert.ok(mems.includes(m.path));
  } finally {
    for (const p of [s.path, sc.path, m.path]) {
      try { fs.unlinkSync(p); } catch { /* already removed */ }
    }
  }
});
