// Shared test helper: keep `workspace/memories/` free of test
// pollution.
//
// Tests that create memory files (session summaries, writeMemory
// outputs, etc.) should call `trackMemory(path)` to register the
// file for cleanup. The first call to `trackMemory` installs a
// process-level `exit` hook that removes every tracked file when the
// test process is done.
//
// Tests that create proposal files in `memories/proposals/` should
// also call `trackMemory(path)` on the proposal path — the same
// per-file `unlinkSync` hook covers any file in `workspace/memories/`.
// A dedicated `trackProposalsDir(dir)` helper is provided for tests
// that point at a throwaway proposals directory outside the real
// workspace: the helper registers the dir for `rm -rf`-style cleanup
// on exit, so an aborted test does not leak a temporary tree.
//
// Why a `process.on('exit')` hook instead of `node:test`'s `after`?
// - `after` is per-file; node:test does not give us a "all suites
//   done" hook. Tests within a file can run in any order.
// - `process.on('exit')` fires on every exit path: a clean run, an
//   assertion failure (the `assert` throws, the runner unwinds,
//   `exit` fires), or a `process.exit()` call. The hook is
//   synchronous, so we use `unlinkSync` / `rmSync`.
// - Forgetting to track a file is fine: the developer notices on the
//   next run because the file is still in `workspace/memories/`.
//   `git status` is the safety net; we do not second-guess untracked
//   files here.
//
// Usage:
//
//   import { trackMemory, trackProposalsDir } from './_memories-cleanup.js';
//
//   test('writeSessionSummary writes a markdown file into memories/', () => {
//     const r = writeSessionSummary({ goal: 'g', exitReason: 'unit test' });
//     trackMemory(r.path);
//     // ... assertions ...
//   });
//
//   test('proposal lifecycle uses a throwaway proposals dir', () => {
//     const proposalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineagent-'));
//     trackProposalsDir(proposalsDir);
//     // ... write proposals, link them, etc. ...
//   });

import fs from 'node:fs';

const tracked = new Set();
const trackedDirs = new Set();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', () => {
    for (const p of tracked) {
      try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
    tracked.clear();
    for (const d of trackedDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    trackedDirs.clear();
  });
}

export function trackMemory(path) {
  install();
  if (typeof path === 'string' && path.length > 0) {
    tracked.add(path);
  }
  return path;
}

// Register a temporary proposals directory for `rm -rf` cleanup on
// test exit. Use this in tests that point at a throwaway proposals
// dir (e.g. via `proposalsDirOverride` on `createSkill`) so an
// aborted test does not leak a temp tree. The hook is the assertion-
// failure safety net; tests should still `rmSync` in `finally` for
// normal cleanup so the workspace stays clean *between* tests.
export function trackProposalsDir(dir) {
  install();
  if (typeof dir === 'string' && dir.length > 0) {
    trackedDirs.add(dir);
  }
  return dir;
}

export function trackedMemories() {
  return [...tracked];
}

export function trackedProposalsDirs() {
  return [...trackedDirs];
}
