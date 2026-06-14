# MineAgent Shutdown Commit Spec

Behavior contract for `commitImprovements()` in `src/shutdown.js` and the proposal lifecycle it depends on. This is the source of truth for what the shutdown commit does. If implementation diverges from this spec, the spec is the bug.

## Purpose

`commitImprovements()` is the bridge between the **proposal workflow** (a persona-driven consult-before-commit loop) and the **git history** (the project's permanent record). The contract is: the only files that ever land in a real commit on the project repo are the ones the user explicitly approved via a proposal. Everything else stays in the working tree until the user decides what to do with it.

The previous behavior was to commit every changed file in `workspace/skills/` and `workspace/scripts/` unconditionally, which contradicted the vision's consult-before-commit rule. The new behavior closes that gap.

## Proposal lifecycle

Proposals live at `workspace/memories/proposals/<name>-<timestamp>.md` (gitignored). Each proposal is a small markdown file with a YAML frontmatter block:

```yaml
---
name: <safeName>
action: create | revise | remove | generalize
kind: doc | code
proposedAt: <iso>
status: proposed | executed
---
```

The status transitions:

| Status | Set by | Meaning |
|---|---|---|
| `proposed` | `propose_skill_change` | The persona has described a change and is waiting for the user's response. |
| `executed` | the matching execute tool (`create_skill`, `update_skill`, `remove_skill`, `create_script`) | The user said yes, the persona called the execute tool, and the file is on disk. The shutdown commit is now allowed to commit it. |
| (deleted) | `reject_proposal` | The user said no, or the proposal was abandoned. |

The transition `proposed → executed` happens inside `linkExecutedProposal()` in `src/improve.js`. It rewrites the frontmatter in place and stamps `executedAt: <iso>`. There is no explicit `approve_proposal` step; the execute tool's call is the approval.

## `commitImprovements({ message?, cwd?, proposalsDir? })`

The shutdown handler calls this function. The CLI, the MCP server, and the persona loop all converge on the same entry point.

**Parameters:**

- `message` (optional, string) — override the commit subject. Default is `shutdown: apply approved skill changes (N files)`.
- `cwd` (optional, string) — test-only override for the git working tree. Production callers leave this null and the function uses the real project root. Tests pass a throwaway repo's path.
- `proposalsDir` (optional, string) — test-only override for the proposals directory. Defaults to the real `workspace/memories/proposals/`. Tests that pass `cwd` for a throwaway must also pass `proposalsDir` for the matching throwaway proposals dir, or the proposal filter will read from the real workspace and silently approve nothing.

**Behavior:**

1. If `cwd` is null and the process is running under a test environment (`MA_TEST_NO_COMMIT=1`, `npm_lifecycle_event === 'test'`, or `NODE_ENV === 'test'`), return `{ ok: true, committed: false, reason: 'test environment: commit suppressed' }` without touching git. This is defense in depth on top of the `cwd` override.
2. Run `git status --porcelain --untracked-files=all workspace/skills workspace/scripts` in the resolved cwd. The `--untracked-files=all` flag is load-bearing: the default `normal` mode hides individual files inside untracked directories and shows the directory entry instead, which would miss every new skill.
3. Parse the porcelain output. Each line is `XY <path>`. Strip directory entries (trailing `/`) and rename arrows (`old -> new`).
4. Build the set of approved skill/script names:
   - If `MA_SHUTDOWN_FORCE_COMMIT=1` is set, the set is empty (every file passes the filter).
   - Otherwise, read every proposal in the resolved proposals dir whose frontmatter status is `executed` (or the deprecated `approved` alias) and collect the `name` fields.
5. For each parsed line, look up the basename-without-extension in the approved set. Approved files go into `toCommit`; the rest go into `unapproved`.
6. If `toCommit` is empty, return `{ ok: true, committed: false, reason, unapproved }` without running git add or git commit. The `reason` is `'unapproved changes left in working tree (no matching proposal)'` if there are unapproved files, otherwise `'no changes in skills/ or scripts/'`.
7. Otherwise, `git add -- <file>` for each approved path (so unapproved files are never swept in by a coarse `git add workspace/skills`), then `git commit -m <subject>`.
8. Return `{ ok: true, committed: true, subject, committedFiles, unapproved }`.

**Result envelope:**

```ts
{
  ok: true,
  committed: boolean,             // true iff a git commit happened
  reason?: string,                // present when committed is false
  subject?: string,               // commit subject (committed=true only)
  committedFiles?: string[],      // files added+committed (committed=true only)
  unapproved: string[]            // files left in the working tree, always present (possibly [])
}
```

`unapproved` is always an array (never `undefined`). When `MA_SHUTDOWN_FORCE_COMMIT=1` is set and there are no unapproved files, `unapproved` is `[]`. Callers that want to branch on "did we leave anything behind" should check `r.unapproved.length > 0`, not `r.unapproved`.

The `shutdown()` wrapper in `src/shutdown.js` returns the same `commitResult` shape under the `commit` key of its own result, so callers of `shutdown()` see `{ ok, summary, commit: { ok, committed, committedFiles?, unapproved, ... } }`.

## Proposal-to-commit mapping

The shutdown commit subject is `shutdown: apply approved skill changes (N file[s])` by default, where N is the number of files in `committedFiles`. The commit message intentionally does not list the filenames; `git show --stat` is the source of truth for that.

Each commit covers only one batch of approved changes. The shutdown handler runs once per session, so a session with three approved skill changes produces one commit (or three, if the user runs shutdown between approvals). Sessions with zero approved changes produce no commit, and the session summary is the only artifact.

## Escape hatch

`MA_SHUTDOWN_FORCE_COMMIT=1` is the only path that bypasses the proposal check. The shutdown handler reads it at call time, so tests can mutate it within a single test. Use cases:

- A developer edits `workspace/skills/foo.md` directly (out of band) and wants the agent to commit it on the next shutdown.
- An automation script runs the shutdown handler in a context where the user has already approved changes by some other channel.

The default is to refuse to commit unapproved files. The escape hatch is opt-in.

## Test-mode guard

When `cwd` is null (production path) and the process is running under a test environment, `commitImprovements()` returns a no-op result. The detection is conservative: it triggers only when an explicit test-runner signal is present (`MA_TEST_NO_COMMIT=1`, `npm_lifecycle_event === 'test'`, or `NODE_ENV === 'test'`). Production callers never set any of these env vars, so the production path is unchanged.

This is defense in depth on top of the `cwd` override. A future test that forgets the throwaway-repo pattern still cannot produce a real commit on the project repo.

## Self-test

`node --test test/shutdown.test.js` verifies:

- The proposal lifecycle: `propose_skill_change` writes a `proposed` proposal; `create_skill` with the matching `proposalId` rewrites the frontmatter to `executed`; `listApprovedProposals` includes the name.
- The implicit-link fallback: `create_skill` without a `proposalId` finds the latest matching `proposed` proposal by name and links it. A 5ms delay between two `propose_skill_change` calls in the test ensures the filenames are distinct.
- `commitImprovements` against a throwaway repo with one approved and one unapproved file commits only the approved one, leaves the unapproved in the working tree, and reports both in the result.
- `commitImprovements` against a throwaway repo with no approved files returns `committed: false` and reports the unapproved files.
- `MA_SHUTDOWN_FORCE_COMMIT=1` bypasses the proposal check and commits every changed file.
- The test-mode env-var guard returns a no-op when `MA_TEST_NO_COMMIT=1` is set.
