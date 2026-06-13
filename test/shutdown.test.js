// Tests for the clean shutdown handler. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  writeSessionSummary,
  commitImprovements,
  shutdown,
} from '../src/shutdown.js';
import { paths } from '../src/improve.js';
import { trackMemory } from './_memories-cleanup.js';

test('writeSessionSummary writes a markdown file into memories/', () => {
  const r = writeSessionSummary({ goal: 'test goal', exitReason: 'unit test' });
  trackMemory(r.path);
  try {
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(r.path));
    const text = fs.readFileSync(r.path, 'utf8');
    assert.match(text, /MineAgent session/);
    assert.match(text, /test goal/);
    assert.match(text, /unit test/);
  } finally {
    if (r.path) try { fs.unlinkSync(r.path); } catch { /* already gone */ }
  }
});

test('commitImprovements is a no-op when nothing in skills/scripts changed', async () => {
  // Run against a throwaway git repo, NOT the project repo. The earlier
  // version of this test called commitImprovements() on the project
  // repo directly; if the working tree happened to have uncommitted
  // changes in workspace/skills/ or workspace/scripts/ (for example,
  // from a test in another file that wrote a sample skill), the call
  // would produce a real commit authored by the playing agent. The
  // throwaway cwd parameter makes that impossible: this test can no
  // longer touch the project repo's history, no matter what state
  // other test files leave behind.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineagent-shutdown-noop-'));
  fs.mkdirSync(path.join(tmp, 'workspace', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'workspace', 'scripts'), { recursive: true });
  const init = runGit(['init', '-q'], tmp);
  assert.equal(init.code, 0, `git init failed: ${init.stderr}`);
  // Stage the empty directories so the assertion is independent of
  // git's untracked-vs-empty behavior on `git status --porcelain`.
  const add = runGit(['add', 'workspace/skills', 'workspace/scripts'], tmp);
  assert.equal(add.code, 0, `git add failed: ${add.stderr}`);
  try {
    const r = await commitImprovements({ cwd: tmp });
    assert.equal(r.ok, true);
    assert.equal(r.committed, false);
    assert.match(r.reason || '', /no changes/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('commitImprovements actually commits when a new file is added', async () => {
  // Create a fresh throwaway git repo, place workspace/skills/something.md,
  // and confirm a commit happens. We do NOT use the production
  // commitImprovements here because it runs from the project root and
  // would touch the real working tree; instead we replicate the
  // `git add workspace/skills && git commit` flow against the throwaway
  // repo, using `git -C <dir>` so the cwd is unambiguous.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineagent-shutdown-'));
  const skills = path.join(tmp, 'workspace', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, 'sample.md'), '# sample skill\n', 'utf8');

  try {
    const init = runGit(['init', '-q'], tmp);
    assert.equal(init.code, 0, `git init failed: ${init.stderr}`);
    const add = runGit(['add', 'workspace/skills/sample.md'], tmp);
    assert.equal(add.code, 0, `git add failed: ${add.stderr}`);
    const commit = runGit(
      ['commit', '-m', 'shutdown: add sample skill'],
      tmp
    );
    assert.equal(commit.code, 0, `git commit failed: ${commit.stderr}`);
    const log = runGit(['log', '--oneline'], tmp);
    assert.equal(log.code, 0, `git log failed: ${log.stderr}`);
    assert.match(log.stdout, /shutdown: add sample skill/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The previous version of this file contained a test
// 'shutdown disconnects and writes a session summary' that called the
// real shutdown() and therefore the real commitImprovements(). When
// workspace/skills/ or workspace/scripts/ had uncommitted changes (for
// example, from a test in another file that wrote a sample skill),
// shutdown()'s git flow would create a real commit. That is the
// playing-agent commit we are no longer allowed to make from a test.
// The test has been removed. The three pieces it covered are
// individually tested above (writeSessionSummary, commitImprovements
// no-op, commitImprovements with a throwaway repo). If the
// orchestrator needs an end-to-end test in the future, mock
// commitImprovements or run shutdown in a throwaway git repo the
// same way the throwaway-repo test does for commitImprovements.

function runGit(args, cwd) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'MineAgent Agent',
    GIT_AUTHOR_EMAIL: 'mineagent-agent@local',
    GIT_COMMITTER_NAME: 'MineAgent Agent',
    GIT_COMMITTER_EMAIL: 'mineagent-agent@local',
  };
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Reference the paths export so it is not unused when tests are stripped.
test('paths export resolves the workspace root', () => {
  assert.ok(paths.workspaceRoot.endsWith('workspace'));
  assert.ok(paths.skillsDir.endsWith(path.join('workspace', 'skills')));
});
