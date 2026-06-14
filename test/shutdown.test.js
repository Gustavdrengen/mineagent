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
  __test_isTestEnvironment,
} from '../src/shutdown.js';
import {
  paths,
  proposeSkillChange,
  createSkill,
  updateSkill,
  removeSkill,
  createScript,
  listApprovedProposals,
  __test_parseProposalFrontmatter,
} from '../src/improve.js';
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

test('__test_isTestEnvironment flips on MA_TEST_NO_COMMIT=1', () => {
  // Small unit test for the helper so the export is referenced
  // somewhere in the test suite. The integration test below
  // ('commitImprovements is a no-op under a test environment')
  // exercises the end-to-end behavior; this test pins the helper's
  // contract.
  //
  // The helper also checks `npm_lifecycle_event` and `NODE_ENV`,
  // which `npm test` sets to `'test'` for the entire run. To test
  // the helper in isolation we clear all three for the duration of
  // the test and restore them in `finally`. Other tests in this
  // file do not depend on any of these env vars; sibling test
  // files run in separate processes (the `node --test` runner
  // forks per file by default), so the env mutation does not
  // leak across files.
  const previousMTC = process.env.MA_TEST_NO_COMMIT;
  const previousLifecycle = process.env.npm_lifecycle_event;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.MA_TEST_NO_COMMIT;
    delete process.env.npm_lifecycle_event;
    delete process.env.NODE_ENV;
    assert.equal(__test_isTestEnvironment(), false);
    process.env.MA_TEST_NO_COMMIT = '1';
    assert.equal(__test_isTestEnvironment(), true);
  } finally {
    if (previousMTC === undefined) delete process.env.MA_TEST_NO_COMMIT;
    else process.env.MA_TEST_NO_COMMIT = previousMTC;
    if (previousLifecycle === undefined) delete process.env.npm_lifecycle_event;
    else process.env.npm_lifecycle_event = previousLifecycle;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('commitImprovements is a no-op under a test environment (defense in depth)', async () => {
  // The throwaway-repo pattern in the other tests already prevents
  // commitImprovements from touching the project repo. This test
  // covers a defense-in-depth layer: even if a future test forgets
  // the throwaway-repo pattern, the function itself refuses to
  // commit when `MA_TEST_NO_COMMIT=1` is set. We mutate the env var
  // for the duration of the test and restore it in `finally` so
  // other tests in this file are not affected.
  //
  // The check is also wired to `npm_lifecycle_event === 'test'` and
  // `NODE_ENV === 'test'`, but those are process-level and cannot
  // be toggled from inside a test without leaking into sibling
  // tests. `MA_TEST_NO_COMMIT` is test-local, so we use it here.
  const previous = process.env.MA_TEST_NO_COMMIT;
  process.env.MA_TEST_NO_COMMIT = '1';
  try {
    const r = await commitImprovements();
    assert.equal(r.ok, true);
    assert.equal(r.committed, false);
    assert.match(r.reason || '', /test environment/);
  } finally {
    if (previous === undefined) delete process.env.MA_TEST_NO_COMMIT;
    else process.env.MA_TEST_NO_COMMIT = previous;
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

// --- The new commit-by-approved-proposal behavior ----------------------
//
// The shutdown handler used to commit every changed file in
// workspace/skills/ and workspace/scripts/ unconditionally. That was
// in tension with the consult-before-commit rule. The new behavior
// is: only commit files whose basename matches a proposal in
// memories/proposals/ whose frontmatter status is `executed` (set by
// the execute tool when the persona calls it after the user said
// yes). Unapproved files are left in the working tree and reported
// in the result.
//
// These tests build a throwaway git repo with workspace/skills/ and
// workspace/memories/proposals/ inside it, write the files we want to
// commit, and assert against the production commitImprovements() via
// the cwd override.

function setupThrowawayRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineagent-shutdown-approved-'));
  const skills = path.join(tmp, 'workspace', 'skills');
  const scripts = path.join(tmp, 'workspace', 'scripts');
  const proposals = path.join(tmp, 'workspace', 'memories', 'proposals');
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(proposals, { recursive: true });
  const init = runGit(['init', '-q'], tmp);
  assert.equal(init.code, 0, `git init failed: ${init.stderr}`);
  // git complains about "fatal: unable to auto-detect email address"
  // when the committer identity is not configured. The production
  // helper sets GIT_AUTHOR_* / GIT_COMMITTER_*; do the same here.
  runGit(['config', 'user.email', 'mineagent-agent@local'], tmp);
  runGit(['config', 'user.name', 'MineAgent Agent'], tmp);
  return { tmp, skills, scripts, proposals };
}

function writeProposal(proposalsDir, { name, status = 'proposed', kind = 'doc' }) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${name}-${ts}.md`;
  const fullPath = path.join(proposalsDir, filename);
  const body = [
    '---',
    `name: ${name}`,
    `action: create`,
    `kind: ${kind}`,
    `proposedAt: ${new Date().toISOString()}`,
    `status: ${status}`,
    '---',
    '',
    `# Proposal: create ${name}`,
    '',
    '## Summary',
    's',
    '',
    '## Reason',
    'r',
    '',
  ].join('\n');
  fs.writeFileSync(fullPath, body, 'utf8');
  return { filename, fullPath, proposalId: filename.replace(/\.md$/, '') };
}

test('commitImprovements only commits files with an approved proposal', async () => {
  const { tmp, skills, proposals } = setupThrowawayRepo();
  try {
    // Two skills: one approved, one not.
    fs.writeFileSync(path.join(skills, 'approved-skill.md'), '# approved\n', 'utf8');
    fs.writeFileSync(path.join(skills, 'unapproved-skill.md'), '# unapproved\n', 'utf8');
    writeProposal(proposals, { name: 'approved-skill', status: 'executed' });
    // No proposal for `unapproved-skill`.

    const r = await commitImprovements({ cwd: tmp, proposalsDir: proposals });
    assert.equal(r.ok, true);
    assert.equal(r.committed, true);
    assert.deepEqual(r.committedFiles, ['workspace/skills/approved-skill.md']);
    assert.deepEqual(r.unapproved, ['workspace/skills/unapproved-skill.md']);
    // The unapproved file is still in the working tree (not removed).
    assert.ok(fs.existsSync(path.join(skills, 'unapproved-skill.md')));
    // The approved file is no longer in the working tree's uncommitted
    // set (git committed it). Use `--untracked-files=all` so the
    // unapproved file is shown by name (the default `normal` mode
    // hides it inside the directory entry `?? workspace/skills/`).
    const status = runGit(
      ['status', '--porcelain', '--untracked-files=all', 'workspace/skills'],
      tmp
    );
    assert.equal(status.code, 0, `git status failed: ${status.stderr}`);
    // The unapproved file is still untracked; the approved file is
    // committed. Use a line-by-line check anchored to the full path
    // so the substring "approved-skill.md" inside the literal
    // "unapproved-skill.md" does not produce a false positive.
    const statusLines = status.stdout.split('\n').filter(Boolean);
    assert.ok(
      statusLines.some((l) => l.includes('workspace/skills/unapproved-skill.md')),
      'unapproved-skill.md should still be in the working tree'
    );
    assert.equal(
      statusLines.some((l) => l.includes('workspace/skills/approved-skill.md')),
      false,
      'approved-skill.md should have been committed and not appear in the working tree'
    );
    // And the commit log has the new commit.
    const log = runGit(['log', '--oneline'], tmp);
    assert.equal(log.code, 0, `git log failed: ${log.stderr}`);
    assert.match(log.stdout, /shutdown: apply approved skill changes/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('commitImprovements leaves every change unapproved when no proposal matches', async () => {
  const { tmp, skills, proposals } = setupThrowawayRepo();
  try {
    fs.writeFileSync(path.join(skills, 'lonely.md'), '# lonely\n', 'utf8');
    const r = await commitImprovements({ cwd: tmp, proposalsDir: proposals });
    assert.equal(r.ok, true);
    assert.equal(r.committed, false);
    assert.match(r.reason || '', /unapproved changes left in working tree/);
    assert.deepEqual(r.unapproved, ['workspace/skills/lonely.md']);
    // `git log` returns 128 in an empty repo (no commits yet); the
    // right check here is that no commit subject landed. Use
    // `git rev-parse --verify HEAD` (returns 0/1) instead of `log`
    // so the assertion does not depend on whether the throwaway
    // repo already has commits.
    const rev = runGit(['rev-parse', '--verify', 'HEAD'], tmp);
    assert.notEqual(rev.code, 0, 'no HEAD should exist when nothing was committed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('commitImprovements counts both .md and .js skills, and .js scripts', async () => {
  const { tmp, skills, scripts, proposals } = setupThrowawayRepo();
  try {
    fs.writeFileSync(path.join(skills, 'js-skill.js'), '// js\n', 'utf8');
    fs.writeFileSync(path.join(scripts, 'js-script.js'), '// script\n', 'utf8');
    writeProposal(proposals, { name: 'js-skill', status: 'executed', kind: 'code' });
    writeProposal(proposals, { name: 'js-script', status: 'executed', kind: 'code' });
    const r = await commitImprovements({ cwd: tmp, proposalsDir: proposals });
    assert.equal(r.ok, true);
    assert.equal(r.committed, true);
    assert.equal(r.committedFiles.length, 2);
    assert.ok(r.committedFiles.includes('workspace/skills/js-skill.js'));
    assert.ok(r.committedFiles.includes('workspace/scripts/js-script.js'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MA_SHUTDOWN_FORCE_COMMIT=1 commits every changed file (escape hatch)', async () => {
  const { tmp, skills } = setupThrowawayRepo();
  // Use a child env so the env mutation does not leak across tests.
  const previous = process.env.MA_SHUTDOWN_FORCE_COMMIT;
  process.env.MA_SHUTDOWN_FORCE_COMMIT = '1';
  try {
    fs.writeFileSync(path.join(skills, 'unapproved-skill.md'), '# x\n', 'utf8');
    const r = await commitImprovements({ cwd: tmp });
    assert.equal(r.ok, true);
    assert.equal(r.committed, true);
    assert.ok(r.committedFiles.includes('workspace/skills/unapproved-skill.md'));
    // With the force flag, the proposal filter is bypassed. No
    // files are unapproved, so `unapproved` is an empty array (the
    // shape is consistent with the non-force path).
    assert.deepEqual(r.unapproved, []);
  } finally {
    if (previous === undefined) delete process.env.MA_SHUTDOWN_FORCE_COMMIT;
    else process.env.MA_SHUTDOWN_FORCE_COMMIT = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('__test_parseProposalFrontmatter reads status and name', () => {
  const text = [
    '---',
    'name: foo',
    'action: create',
    'kind: doc',
    'proposedAt: 2026-06-14T00:00:00.000Z',
    'status: executed',
    '---',
    '',
    '# body',
  ].join('\n');
  const fm = __test_parseProposalFrontmatter(text);
  assert.equal(fm.name, 'foo');
  assert.equal(fm.status, 'executed');
  assert.equal(fm.action, 'create');
  assert.equal(fm.kind, 'doc');
});

test('__test_parseProposalFrontmatter returns null when no frontmatter', () => {
  assert.equal(__test_parseProposalFrontmatter('just a body\n'), null);
});

test('execute tools mark the matching proposal as executed (proposalId explicit)', () => {
  // This test uses the real workspace, not a throwaway, because the
  // link helper writes to proposalsDir (which is the real
  // memories/proposals/). It is hermetic: the proposal is created,
  // the execute tool runs, the proposal is checked, and the skill
  // file + proposal are removed in `finally`. The memory file's
  // own cleanup helper (trackMemory) does not cover the proposals
  // directory, so this test cleans up explicitly.
  const skillsDir = paths.skillsDir;
  const proposalsDir = paths.proposalsDir;
  fs.mkdirSync(proposalsDir, { recursive: true });
  const r = proposeSkillChange({
    name: 'link-test-explicit',
    action: 'create',
    body: '## Body',
    summary: 's',
    reason: 'r',
  });
  assert.equal(r.ok, true);
  const proposalId = r.proposalId;
  const proposalPath = path.join(proposalsDir, `${proposalId}.md`);
  const skillPath = path.join(skillsDir, 'link-test-explicit.md');
  try {
    // Pre-condition: proposal is `proposed`.
    const before = fs.readFileSync(proposalPath, 'utf8');
    assert.match(before, /status: proposed/);
    // Run the execute tool with the explicit proposalId.
    const exec = createSkill({
      name: 'link-test-explicit',
      body: '## Body',
      kind: 'doc',
      proposalId,
    });
    assert.equal(exec.ok, true);
    assert.equal(exec.proposalLinked, true);
    assert.equal(exec.proposalId, proposalId);
    // Post-condition: proposal is `executed` and has an executedAt.
    const after = fs.readFileSync(proposalPath, 'utf8');
    assert.match(after, /status: executed/);
    assert.match(after, /executedAt: \d{4}-\d{2}-\d{2}/);
    // And the skill file is on disk.
    assert.ok(fs.existsSync(skillPath));
  } finally {
    if (fs.existsSync(skillPath)) fs.unlinkSync(skillPath);
    if (fs.existsSync(proposalPath)) fs.unlinkSync(proposalPath);
  }
});

test('execute tools link the latest matching proposed proposal when no proposalId is passed', async () => {
  const skillsDir = paths.skillsDir;
  const proposalsDir = paths.proposalsDir;
  fs.mkdirSync(proposalsDir, { recursive: true });
  // Two proposals for the same name. The proposal filename embeds
  // an ISO timestamp with millisecond precision, so two proposals
  // created in the same millisecond would collide on filename and
  // the second would overwrite the first. Wait a tick so the
  // timestamps are distinct; the test verifies that the newer
  // proposal is the one that gets linked.
  const r1 = proposeSkillChange({
    name: 'link-test-implicit',
    action: 'create',
    body: '## Body v1',
    summary: 's',
    reason: 'r',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const r2 = proposeSkillChange({
    name: 'link-test-implicit',
    action: 'create',
    body: '## Body v2',
    summary: 's',
    reason: 'r',
  });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const p1 = path.join(proposalsDir, `${r1.proposalId}.md`);
  const p2 = path.join(proposalsDir, `${r2.proposalId}.md`);
  const skillPath = path.join(skillsDir, 'link-test-implicit.md');
  try {
    const exec = createSkill({
      name: 'link-test-implicit',
      body: '## Body v2',
      kind: 'doc',
    });
    assert.equal(exec.ok, true);
    assert.equal(exec.proposalLinked, true);
    // The newer proposal (r2) is the one that was linked.
    assert.equal(exec.proposalId, r2.proposalId);
    // The older proposal is untouched.
    const p1Text = fs.readFileSync(p1, 'utf8');
    assert.match(p1Text, /status: proposed/);
    // The newer proposal is `executed`.
    const p2Text = fs.readFileSync(p2, 'utf8');
    assert.match(p2Text, /status: executed/);
  } finally {
    if (fs.existsSync(skillPath)) fs.unlinkSync(skillPath);
    if (fs.existsSync(p1)) fs.unlinkSync(p1);
    if (fs.existsSync(p2)) fs.unlinkSync(p2);
  }
});

test('listApprovedProposals returns only proposals with status=executed', () => {
  const proposalsDir = paths.proposalsDir;
  fs.mkdirSync(proposalsDir, { recursive: true });
  // Three proposals; only the `executed` ones should appear in the
  // list. The test does not care which other statuses are present
  // (proposed, rejected-after-creation, etc.) — it just asserts
  // every entry in the result has status executed.
  const r1 = proposeSkillChange({
    name: 'list-approved-1',
    action: 'create',
    body: 'b',
    summary: 's',
    reason: 'r',
  });
  const r2 = proposeSkillChange({
    name: 'list-approved-2',
    action: 'create',
    body: 'b',
    summary: 's',
    reason: 'r',
  });
  const r3 = proposeSkillChange({
    name: 'list-approved-3',
    action: 'create',
    body: 'b',
    summary: 's',
    reason: 'r',
  });
  const p1 = path.join(proposalsDir, `${r1.proposalId}.md`);
  const p2 = path.join(proposalsDir, `${r2.proposalId}.md`);
  const p3 = path.join(proposalsDir, `${r3.proposalId}.md`);
  try {
    // Mark r1 and r3 as executed (not r2).
    const stamp = new Date().toISOString();
    fs.writeFileSync(
      p1,
      fs.readFileSync(p1, 'utf8').replace(/^status:\s*proposed$/m, 'status: executed'),
      'utf8'
    );
    fs.writeFileSync(
      p3,
      fs.readFileSync(p3, 'utf8')
        .replace(/^status:\s*proposed$/m, 'status: executed')
        .replace(/\n(?!.*executedAt)/s, `\nexecutedAt: ${stamp}\n`),
      'utf8'
    );
    const names = listApprovedProposals();
    assert.ok(names.includes('list-approved-1'), 'list-approved-1 should be approved');
    assert.ok(names.includes('list-approved-3'), 'list-approved-3 should be approved');
    assert.equal(names.includes('list-approved-2'), false, 'list-approved-2 is still proposed');
  } finally {
    if (fs.existsSync(p1)) fs.unlinkSync(p1);
    if (fs.existsSync(p2)) fs.unlinkSync(p2);
    if (fs.existsSync(p3)) fs.unlinkSync(p3);
  }
});

test('listApprovedProposals reads from an explicit proposalsDir override', () => {
  // The shutdown handler and the persona loop both need to be able to
  // ask "which names have an approved proposal?" against a specific
  // directory. In production that's the real workspace proposals dir;
  // in tests it can be a throwaway. The override path keeps the two
  // callers on the same code path.
  const { proposals } = setupThrowawayRepo();
  try {
    writeProposal(proposals, { name: 'override-foo', status: 'executed' });
    writeProposal(proposals, { name: 'override-bar', status: 'proposed' });
    const names = listApprovedProposals(proposals);
    assert.ok(names.includes('override-foo'), 'override-foo is executed');
    assert.equal(names.includes('override-bar'), false, 'override-bar is still proposed');
  } finally {
    for (const f of fs.readdirSync(proposals)) {
      fs.unlinkSync(path.join(proposals, f));
    }
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
