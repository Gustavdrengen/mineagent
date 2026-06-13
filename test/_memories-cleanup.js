// Shared test helper: keep `workspace/memories/` free of test
// pollution.
//
// Tests that create memory files (session summaries, writeMemory
// outputs, etc.) should call `trackMemory(path)` to register the
// file for cleanup. The first call to `trackMemory` installs a
// process-level `exit` hook that removes every tracked file when the
// test process is done.
//
// Why a `process.on('exit')` hook instead of `node:test`'s `after`?
// - `after` is per-file; node:test does not give us a "all suites
//   done" hook. Tests within a file can run in any order.
// - `process.on('exit')` fires on every exit path: a clean run, an
//   assertion failure (the `assert` throws, the runner unwinds,
//   `exit` fires), or a `process.exit()` call. The hook is
//   synchronous, so we use `unlinkSync`.
// - Forgetting to track a file is fine: the developer notices on the
//   next run because the file is still in `workspace/memories/`.
//   `git status` is the safety net; we do not second-guess untracked
//   files here.
//
// Usage:
//
//   import { trackMemory } from './_memories-cleanup.js';
//
//   test('writeSessionSummary writes a markdown file into memories/', () => {
//     const r = writeSessionSummary({ goal: 'g', exitReason: 'unit test' });
//     trackMemory(r.path);
//     // ... assertions ...
//   });

import fs from 'node:fs';

const tracked = new Set();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', () => {
    for (const p of tracked) {
      try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
    tracked.clear();
  });
}

export function trackMemory(path) {
  install();
  if (typeof path === 'string' && path.length > 0) {
    tracked.add(path);
  }
  return path;
}

export function trackedMemories() {
  return [...tracked];
}
