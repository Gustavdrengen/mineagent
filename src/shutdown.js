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
import { paths, listApprovedProposals } from './improve.js';

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
 * **Decision:** Only commit files that have a matching approved
 * proposal in `memories/proposals/`. **Tier:** T1. **Evidence:** A
 * user reported two `shutdown: promote session improvements` commits
 * appearing in history at 9:02 and 10:32 AM on 2026-06-14, neither
 * of which was an explicit commit by the user. The state-of-play
 * note has flagged the auto-commit path as in tension with the
 * consult-before-commit rule for five entries in a row. The new
 * behavior reads the proposals directory, builds a set of names
 * whose proposal status is `executed`, and only adds/commits
 * working-tree files whose basename matches. Unapproved files are
 * left in the tree and reported in the result as `unapproved` so
 * the persona loop (or the CLI) can surface them to the user. The
 * test-mode env-var guard and the throwaway-repo pattern in
 * `test/shutdown.test.js` both stay in place as defense in depth.
 * **Trade-off:** The persona can no longer rely on shutdown as a
 * blanket "commit everything I changed" path. The intent is to
 * force the consult-before-commit rule to be the only path from
 * intent to a real commit on the project repo. A power user who
 * wants the old behavior can set `MA_SHUTDOWN_FORCE_COMMIT=1` to
 * bypass the proposal check (escape hatch for the rare case where
 * the user has edited skills out-of-band and wants the agent to
 * commit them anyway).
 *
 * @param {object} [options]
 * @param {string|null} [options.message] - Optional commit subject.
 * @param {string|null} [options.cwd] - Test-only override.
 * @param {string|null} [options.proposalsDir] - Test-only override for
 *   the proposals directory. Defaults to the real workspace proposals
 *   dir. Tests that point `cwd` at a throwaway repo must also point
 *   `proposalsDir` at the matching throwaway proposals dir; otherwise
 *   the proposal filter reads from the real workspace and silently
 *   approves nothing.
 */
export async function commitImprovements({ message = null, cwd: cwdOverride = null, proposalsDir: proposalsDirOverride = null } = {}) {
  // Defense in depth: even though tests are expected to pass `cwdOverride`
  // pointing at a throwaway repo, also refuse to commit when we detect
  // we're running under a test runner. A future test that forgets the
  // throwaway-repo pattern still cannot produce a real commit on the
  // project repo.
  if (cwdOverride == null && isTestEnvironment()) {
    return {
      ok: true,
      committed: false,
      reason: 'test environment: commit suppressed',
    };
  }
  const cwd = cwdOverride || path.resolve(paths.workspaceRoot, '..');
  // `--untracked-files=all` is load-bearing: the default (`normal`)
  // hides individual files inside untracked directories and shows the
  // directory itself (`?? workspace/skills/`) instead. A new skill
  // created in this session lives inside `workspace/skills/`; the
  // default mode would never see it. With `all`, git reports each
  // file so the proposal filter can match the basename.
  const statusResult = await run(
    'git',
    [
      'status',
      '--porcelain',
      '--untracked-files=all',
      'workspace/skills',
      'workspace/scripts',
    ],
    cwd
  );
  if (!statusResult.ok) {
    return { ok: false, error: 'git status failed', detail: statusResult.stderr || statusResult.error };
  }
  const statusLines = statusResult.stdout.split('\n').filter((l) => l.trim().length > 0);
  if (statusLines.length === 0) {
    return { ok: true, committed: false, reason: 'no changes in skills/ or scripts/' };
  }

  // Build the set of approved skill/script names from the proposals
  // directory. An "approved" proposal is one whose frontmatter
  // status is `executed` (set by the execute tool when the persona
  // calls it after the user said yes) or the deprecated `approved`
  // alias kept for back-compat.
  //
  // The escape hatch `MA_SHUTDOWN_FORCE_COMMIT=1` bypasses this
  // check and commits every changed file. It is intentionally not
  // the default; the consult-before-commit rule is the gate.
  const force = process.env.MA_SHUTDOWN_FORCE_COMMIT === '1';
  const approved = new Set();
  if (!force) {
    for (const name of listApprovedProposals(proposalsDirOverride)) {
      approved.add(name);
    }
  }

  // Filter the porcelain status output: each line is "XY <path>"
  // where XY is the two-letter status. We only care about the path,
  // and we map it to the file's basename without extension to
  // compare against the approved set. Directory entries (which
  // `--untracked-files=all` should not produce, but a defensive
  // filter never hurts) end with `/` and are skipped.
  const toCommit = [];
  const unapproved = [];
  for (const line of statusLines) {
    // The path is the substring after the first space; the
    // surrounding whitespace is the porcelain status letters.
    const firstSpace = line.indexOf(' ');
    if (firstSpace === -1) continue;
    const filePath = line.slice(firstSpace + 1).trim();
    if (filePath.endsWith('/')) continue;
    // Strip rename "old -> new" so we operate on the new path.
    const finalPath = filePath.includes(' -> ')
      ? filePath.split(' -> ').pop().trim()
      : filePath;
    const basename = path.basename(finalPath);
    const name = basename.replace(/\.(md|js)$/, '');
    if (force || approved.has(name)) {
      toCommit.push(finalPath);
    } else {
      unapproved.push(finalPath);
    }
  }

  if (toCommit.length === 0) {
    return {
      ok: true,
      committed: false,
      reason:
        unapproved.length > 0
          ? 'unapproved changes left in working tree (no matching proposal)'
          : 'no changes in skills/ or scripts/',
      unapproved,
    };
  }

  // Add only the approved paths so an unapproved file is never
  // swept in by a coarse `git add workspace/skills workspace/scripts`.
  for (const filePath of toCommit) {
    const addResult = await run('git', ['add', '--', filePath], cwd);
    if (!addResult.ok) {
      return { ok: false, error: `git add failed for ${filePath}`, detail: addResult.stderr || addResult.error };
    }
  }
  const subject =
    message ||
    `shutdown: apply approved skill changes (${toCommit.length} file${toCommit.length === 1 ? '' : 's'})`;
  const commit = await run('git', ['commit', '-m', subject], cwd);
  if (!commit.ok) {
    return { ok: false, error: 'git commit failed', detail: commit.stderr || commit.error };
  }
  return {
    ok: true,
    committed: true,
    subject,
    committedFiles: toCommit,
    unapproved,
  };
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

