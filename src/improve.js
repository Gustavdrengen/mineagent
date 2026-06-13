// Self-improvement tools for MineAgent.
//
// These are the tools the agent loop uses to grow the workspace during a
// run. They write into workspace/skills/, workspace/scripts/, and
// workspace/memories/ (gitignored). The shutdown handler reads the same
// directories to decide what to commit and what to keep local.
//
// This module also owns the persistent "last-known server" memory that
// powers the vision's "from a previous run saved in memories/" branch.
// That memory lives at workspace/memories/last-server.json and is
// gitignored. The persona reads it via `connect_to_last_known_server`
// and the CLI can offer it as a default when the user does not provide
// a host.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..', 'workspace');
const skillsDir = path.join(workspaceRoot, 'skills');
const scriptsDir = path.join(workspaceRoot, 'scripts');
const memoriesDir = path.join(workspaceRoot, 'memories');
const lastServerFile = path.join(memoriesDir, 'last-server.json');

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
  return listDir(memoriesDir, ['.md', '.json']);
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

// --- Last-known server memory ------------------------------------------
//
// Stored at workspace/memories/last-server.json (gitignored). Each call
// to connectToServer() updates this file with the latest attempt; a
// successful connection records host/port/username/timestamp, a failed
// one records the structured error result. Reading the file is best
// effort: a missing or corrupt file yields null, not an exception.

export function readLastServer() {
  try {
    if (!fs.existsSync(lastServerFile)) return null;
    const text = fs.readFileSync(lastServerFile, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// `writeLastServer` is intentionally tolerant: only non-empty
// `host`/`port`/`username` arguments overwrite the previous value, and
// `lastError` always overwrites so the most recent attempt is recorded.
export function writeLastServer({ host, port, username, lastError } = {}) {
  try {
    ensureDir(memoriesDir);
    const previous = readLastServer() || {};
    const cleanHost = typeof host === 'string' && host.length > 0 ? host : previous.host ?? null;
    // Port must be a positive integer; 0/NaN/null are all treated as
    // "no value" and fall back to the previous memory. (Port 0 is
    // never a valid TCP port, so the relaxed check is safe.)
    const cleanPort =
      Number.isFinite(port) && port > 0 ? port : previous.port ?? 25565;
    const cleanUsername =
      typeof username === 'string' && username.length > 0
        ? username
        : previous.username ?? null;
    const next = {
      host: cleanHost,
      port: cleanPort,
      username: cleanUsername,
      lastConnectedAt: cleanHost !== previous.host || cleanPort !== previous.port
        ? new Date().toISOString()
        : previous.lastConnectedAt ?? null,
      lastError: lastError != null ? lastError : previous.lastError ?? null,
    };
    fs.writeFileSync(lastServerFile, JSON.stringify(next, null, 2), 'utf8');
    return { ok: true, path: lastServerFile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function clearLastServer() {
  try {
    if (fs.existsSync(lastServerFile)) {
      fs.unlinkSync(lastServerFile);
    }
    return { ok: true, forgotten: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const paths = {
  workspaceRoot,
  skillsDir,
  scriptsDir,
  memoriesDir,
  lastServerFile,
};
