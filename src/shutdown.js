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

// Defense in depth: even though tests are expected to pass `cwdOverride`
// pointing at a throwaway repo, also refuse to commit when we detect
// we're running under a test runner. A future test that forgets the
// throwaway-repo pattern still cannot produce a real commit on the
// project repo. The check is conservative: it triggers only when an
// explicit "this is a test run" signal is present. Production callers
// (the CLI, the MCP server, the LLM-driven persona) never set any of
// these env vars, so the production path is unchanged.
function isTestEnvironment() {
  if (process.env.MA_TEST_NO_COMMIT === '1') return true;
  if (process.env.npm_lifecycle_event === 'test') return true;
  if (process.env.NODE_ENV === 'test') return true;
  return false;
}

// Test-only export so the regression test can assert the env-var
// detection without having to mutate `process.env` from inside a test
// (which would race with parallel test files).
export function __test_isTestEnvironment() {
  return isTestEnvironment();
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

/**
 * Commit pending changes in `workspace/skills/` and `workspace/scripts/`.
 *
 * Production callers should leave `cwd` null. The `cwd` parameter exists
 * for tests: a test that needs to exercise the function without
 * touching the project repo passes a throwaway git repo's path. A
 * production caller passing `cwd` from the public surface would
 * silently point git at the wrong directory, so treat this as
 * test-only and route production callers through the default path.
 *
 * **Decision:** Also refuse to commit when running under a test
 * environment, even if `cwd` is null. **Tier:** T1. **Evidence:** A
 * user reported two `shutdown: promote session improvements` commits
 * appearing in history at 9:02 and 10:32 AM on 2026-06-14, neither of
 * which was an explicit commit by the user. The state-of-play note
 * has flagged the auto-commit path as in tension with the
 * consult-before-commit rule for five entries in a row. The throwaway-
 * repo pattern in `test/shutdown.test.js` is correct, but a defensive
 * guard at the source means a future test that forgets the pattern
 * still cannot produce a real commit. **Trade-off:** Production
 * behavior is unchanged (production callers never set the env vars
 * that trigger the guard). A test that wants the old behavior can
 * unset all three env vars in its setup.
 *
 * @param {object} [options]
 * @param {string|null} [options.message] - Optional commit subject.
 * @param {string|null} [options.cwd] - Test-only override.
 */
export async function commitImprovements({ message = null, cwd: cwdOverride = null } = {}) {
  // Run a git commit if there is anything in the workspace to commit. We
  // intentionally limit the commit to skills/ and scripts/ to honor the
  // shutdown rule that session-specific memories stay uncommitted.
  //
  // The `cwd` parameter exists for tests: callers can point the function
  // at a throwaway git repo so a misbehaving test never produces a real
  // commit on the project repo. Production code should leave it null.
  //
  // The `isTestEnvironment()` check is a defense-in-depth layer on top
  // of that: even if a test forgets the throwaway-repo pattern, it
  // still cannot produce a real commit against the project repo.
  if (cwdOverride == null && isTestEnvironment()) {
    return {
      ok: true,
      committed: false,
      reason: 'test environment: commit suppressed',
    };
  }
  const cwd = cwdOverride || path.resolve(paths.workspaceRoot, '..');
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

