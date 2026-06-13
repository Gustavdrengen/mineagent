// Self-improvement tools for MineAgent.
//
// These are the tools the agent loop uses to grow the workspace during a
// run. They write into workspace/skills/, workspace/scripts/, and
// workspace/memories/ (gitignored). The shutdown handler reads the same
// directories to decide what to commit and what to keep local.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..', 'workspace');
const skillsDir = path.join(workspaceRoot, 'skills');
const scriptsDir = path.join(workspaceRoot, 'scripts');
const memoriesDir = path.join(workspaceRoot, 'memories');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9_\-]+$/i.test(name)) {
    return null;
  }
  return name;
}

export function createSkill({ name, body, kind = 'doc' } = {}) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'name must be alphanumeric (a-z 0-9 _ -)' };
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, error: 'body is required' };
  }
  ensureDir(skillsDir);
  const filename = kind === 'code' ? `${safe}.js` : `${safe}.md`;
  const target = path.join(skillsDir, filename);
  fs.writeFileSync(target, body, 'utf8');
  return { ok: true, path: target };
}

export function createScript({ name, body } = {}) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'name must be alphanumeric (a-z 0-9 _ -)' };
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, error: 'body is required' };
  }
  ensureDir(scriptsDir);
  const target = path.join(scriptsDir, `${safe}.js`);
  fs.writeFileSync(target, body, 'utf8');
  return { ok: true, path: target };
}

export function writeMemory({ name, body } = {}) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'name must be alphanumeric (a-z 0-9 _ -)' };
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, error: 'body is required' };
  }
  ensureDir(memoriesDir);
  const target = path.join(memoriesDir, `${safe}.md`);
  fs.writeFileSync(target, body, 'utf8');
  return { ok: true, path: target };
}

export function listSkills() {
  return listDir(skillsDir, ['.md', '.js']);
}

export function listScripts() {
  return listDir(scriptsDir, ['.js']);
}

export function listMemories() {
  return listDir(memoriesDir, ['.md']);
}

function listDir(dir, exts) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => exts.includes(path.extname(f)))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export const paths = {
  workspaceRoot,
  skillsDir,
  scriptsDir,
  memoriesDir,
};
