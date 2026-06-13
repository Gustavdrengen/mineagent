// Clean shutdown for MineAgent.
//
// When the user tells the bot to shut down, this module:
//  1. Stops taking new work
//  2. Writes a session summary into workspace/memories/ (gitignored)
//  3. Promotes any useful self-improvements (committed skills/scripts)
//  4. Attempts a single git commit in the workspace with a
//     "shutdown:" commit message; leaves the working tree dirty on
//     failure (so a human can review)
//  5. Disconnects from the server
//
// The function is non-throwing: it always returns a structured result so
// the CLI can print a useful summary and the observer can render the
// final state.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { snapshot, setCurrentTask, recordAction } from './state.js';
import { emit } from './events.js';
import { disconnectFromServer } from './connection.js';
import { paths } from './improve.js';

const GIT_TIMEOUT_MS = 10_000;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function writeSessionSummary({ goal, exitReason } = {}) {
  const memDir = paths.memoriesDir;
  fs.mkdirSync(memDir, { recursive: true });
  const file = path.join(memDir, `session-${timestamp()}.md`);
  const snap = snapshot();
  const body = [
    `# MineAgent session — ${new Date().toISOString()}`,
    '',
    '## Status',
    `- Connection: ${snap.status}`,
    `- Server: ${snap.host || 'n/a'}:${snap.port || 'n/a'}`,
    `- Bot: ${snap.username}`,
    `- Last error: ${snap.lastError || 'n/a'}`,
    `- Exit reason: ${exitReason || 'user requested'}`,
    '',
    '## Goal',
    goal ? goal : 'no explicit goal provided',
    '',
    '## Chat (most recent first)',
    ...snap.chatHistory
      .slice()
      .reverse()
      .map((c) => `- <${c.from}> ${c.message}`),
    '',
    '## Voice events',
    ...snap.voiceEvents
      .slice()
      .reverse()
      .map((v) => `- ${v.text}`),
    '',
    '## Recent actions',
    ...snap.recentActions
      .slice()
      .reverse()
      .map((a) => `- ${a.action}${a.detail ? ` — ${a.detail}` : ''}`),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { ok: true, path: file };
}

function run(cmd, args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: e.message });
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: out, stderr: err, error: e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, code, stdout: out, stderr: err, timedOut: true, error: 'git timed out' });
        return;
      }
      resolve({ ok: code === 0, code, stdout: out, stderr: err });
    });
  });
}

export async function commitImprovements({ message = null } = {}) {
  // Run a git commit if there is anything in the workspace to commit. We
  // intentionally limit the commit to skills/ and scripts/ to honor the
  // shutdown rule that session-specific memories stay uncommitted.
  const cwd = path.resolve(paths.workspaceRoot, '..');
  const status = await run('git', ['status', '--porcelain', 'workspace/skills', 'workspace/scripts'], cwd);
  if (!status.ok) {
    return { ok: false, error: 'git status failed', detail: status.stderr || status.error };
  }
  if (!status.stdout.trim()) {
    return { ok: true, committed: false, reason: 'no changes in skills/ or scripts/' };
  }
  const add = await run('git', ['add', 'workspace/skills', 'workspace/scripts'], cwd);
  if (!add.ok) return { ok: false, error: 'git add failed', detail: add.stderr || add.error };
  const subject =
    message ||
    `shutdown: promote session improvements (${new Date().toISOString()})`;
  const commit = await run('git', ['commit', '-m', subject], cwd);
  if (!commit.ok) {
    return { ok: false, error: 'git commit failed', detail: commit.stderr || commit.error };
  }
  return { ok: true, committed: true, subject };
}

export async function shutdown({ goal = null, exitReason = 'user requested' } = {}) {
  setCurrentTask('shutting down');
  recordAction('shutdown', exitReason);
  emit('state', snapshot());

  const summary = writeSessionSummary({ goal, exitReason });
  let commitResult = { ok: true, committed: false, reason: 'memories only' };
  try {
    commitResult = await commitImprovements();
  } catch (err) {
    commitResult = { ok: false, error: err.message };
  }

  disconnectFromServer();
  setCurrentTask('offline');
  emit('state', snapshot());

  return {
    ok: true,
    summary: summary.path,
    commit: commitResult,
  };
}

