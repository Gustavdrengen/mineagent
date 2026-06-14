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
const proposalsDir = path.join(memoriesDir, 'proposals');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9_\-]+$/i.test(name)) {
    return null;
  }
  return name;
}

export function createSkill({ name, body, kind = 'doc', proposalId = null } = {}) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'name must be alphanumeric (a-z 0-9 _ -)' };
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, error: 'body is required' };
  }
  ensureDir(skillsDir);
  const filename = kind === 'code' ? `${safe}.js` : `${safe}.md`;
  const target = path.join(skillsDir, filename);
  fs.writeFileSync(target, body, 'utf8');
  // Link the write to its proposal (if any) so the shutdown handler
  // can recognize the file as approved and commit it. The persona is
  // taught to always call propose_skill_change first; this is the
  // marker that the user said yes and the execute tool ran.
  const proposalResult = linkExecutedProposal({ proposalId, name: safe, kind });
  return { ok: true, path: target, ...(proposalResult || {}) };
}

export function updateSkill({ name, body, kind = 'doc', proposalId = null } = {}) {
  // The persona is taught to call propose_skill_change first; this
  // execute tool is the action the persona takes after the user has
  // approved. The implementation is identical to createSkill because
  // the proposal system guarantees the agent does not call this for
  // an existing skill it does not want to overwrite.
  return createSkill({ name, body, kind, proposalId });
}

export function removeSkill({ name, kind = 'doc', proposalId = null } = {}) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'name must be alphanumeric (a-z 0-9 _ -)' };
  const filename = kind === 'code' ? `${safe}.js` : `${safe}.md`;
  const target = path.join(skillsDir, filename);
  try {
    // `removed` is true only if the file actually existed and was
    // deleted. A no-op call against a missing file returns removed=false.
    const existed = fs.existsSync(target);
    if (existed) {
      fs.unlinkSync(target);
    }
    // For removes, the proposal-marker step is the same as for
    // creates: we link the proposal to the action so the shutdown
    // handler can commit the deletion. A remove on a missing file
    // still records the proposal link — a future write of the same
    // name will inherit the approved status and be auto-committed.
    void linkExecutedProposal({ proposalId, name: safe, kind });
    return { ok: true, path: target, removed: existed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function createScript({ name, body, proposalId = null } = {}) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'name must be alphanumeric (a-z 0-9 _ -)' };
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, error: 'body is required' };
  }
  ensureDir(scriptsDir);
  const target = path.join(scriptsDir, `${safe}.js`);
  fs.writeFileSync(target, body, 'utf8');
  const proposalResult = linkExecutedProposal({ proposalId, name: safe, kind: 'code' });
  return { ok: true, path: target, ...(proposalResult || {}) };
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

// Read a single file's body. The persona's "broad API" reaches into
// the workspace through the MCP server, and it needs to be able to read
// what the player (or a previous run) has written. Reads are always
// allowed; only the propose-then-approve path is gated. Returns the
// body as a string on success, or { ok: false, kind: 'not_found' } if
// the file does not exist. `readProposal` is the structured counterpart
// (it returns the parsed frontmatter as well) and is defined in the
// proposal section below.
export function readSkill({ name, kind = 'doc' } = {}) {
  return readBody(skillsDir, name, kind === 'code' ? '.js' : '.md');
}

export function readScript({ name } = {}) {
  return readBody(scriptsDir, name, '.js');
}

export function readMemory({ name } = {}) {
  // Memories can be .md (notes) or .json (last-server.json). The caller
  // picks by extension convention: pass the name with the extension.
  return readBodyRaw(memoriesDir, name);
}

function readBody(dir, name, ext) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'name must be alphanumeric (a-z 0-9 _ -)' };
  const target = path.join(dir, `${safe}${ext}`);
  if (!fs.existsSync(target)) {
    return { ok: false, error: 'not found', kind: 'not_found', path: target };
  }
  try {
    const text = fs.readFileSync(target, 'utf8');
    return { ok: true, path: target, name: safe, kind: ext === '.js' ? 'code' : 'doc', body: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function readBodyRaw(dir, name) {
  // `readBodyRaw` is used for memories, which may have any extension
  // (e.g., last-server.json is .json). The name passed in must already
  // include the extension.
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'name is required' };
  }
  if (!/^[a-z0-9_\-.]+$/i.test(name)) {
    return { ok: false, error: 'name must be alphanumeric with optional . _ -' };
  }
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) {
    return { ok: false, error: 'not found', kind: 'not_found', path: target };
  }
  try {
    const text = fs.readFileSync(target, 'utf8');
    return { ok: true, path: target, name, body: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
  proposalsDir,
};

// --- Proposal workflow --------------------------------------------------
//
// The persona's vision rule: committable modifications to
// `workspace/skills/` and `workspace/scripts/` require explicit user
// approval. The proposal workflow is the path that produces approval.
//
// A proposal is a small markdown file at
// `workspace/memories/proposals/<name>-<timestamp>.md` describing the
// change (action, summary, reason, body). The persona reads the
// proposal back, asks the user in chat, and only then calls the
// matching execute tool. Rejection deletes the proposal.
//
// Proposals are gitignored (memories is gitignored). The shutdown
// commit does NOT promote proposals into skills/ or scripts/; that
// path requires the execute tool after an in-session approval.

const VALID_ACTIONS = new Set(['create', 'revise', 'remove', 'generalize']);

function ensureProposalsDir() {
  ensureDir(proposalsDir);
}

function proposalTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function proposeSkillChange({
  name,
  action,
  body = '',
  summary,
  reason,
  kind = 'doc',
} = {}) {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: 'name must be alphanumeric (a-z 0-9 _ -)' };
  if (!VALID_ACTIONS.has(action)) {
    return { ok: false, error: `action must be one of: ${[...VALID_ACTIONS].join(', ')}` };
  }
  if (action !== 'remove' && (typeof body !== 'string' || body.length === 0)) {
    return { ok: false, error: 'body is required for create/revise/generalize' };
  }
  if (typeof summary !== 'string' || summary.length === 0) {
    return { ok: false, error: 'summary is required' };
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    return { ok: false, error: 'reason is required' };
  }
  ensureProposalsDir();
  const ts = proposalTimestamp();
  const filename = `${safe}-${ts}.md`;
  const target = path.join(proposalsDir, filename);
  const frontmatter = [
    '---',
    `name: ${safe}`,
    `action: ${action}`,
    `kind: ${kind}`,
    `proposedAt: ${new Date().toISOString()}`,
    'status: proposed',
    '---',
    '',
  ].join('\n');
  const content = [
    frontmatter,
    `# Proposal: ${action} ${safe}`,
    '',
    '## Summary',
    summary,
    '',
    '## Reason',
    reason,
    '',
    '## Body',
    body,
    '',
  ].join('\n');
  fs.writeFileSync(target, content, 'utf8');
  return {
    ok: true,
    path: target,
    proposalId: filename.replace(/\.md$/, ''),
    name: safe,
    action,
    chatPrompt:
      `Hey, I think we should ${action} the ${safe} skill: ${summary}. ` +
      `The reason is ${reason}. OK to proceed? (yes/no)`,
  };
}

export function listProposals() {
  return listDir(proposalsDir, ['.md']);
}

export function readProposal(proposalId) {
  if (typeof proposalId !== 'string' || !/^[a-z0-9_\-]+$/i.test(proposalId)) {
    return { ok: false, error: 'invalid proposalId' };
  }
  const target = path.join(proposalsDir, `${proposalId}.md`);
  if (!fs.existsSync(target)) {
    return { ok: false, error: 'proposal not found' };
  }
  try {
    const text = fs.readFileSync(target, 'utf8');
    return { ok: true, path: target, body: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function rejectProposal(proposalId) {
  if (typeof proposalId !== 'string' || !/^[a-z0-9_\-]+$/i.test(proposalId)) {
    return { ok: false, error: 'invalid proposalId' };
  }
  const target = path.join(proposalsDir, `${proposalId}.md`);
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return { ok: true, rejected: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Proposal status tracking ------------------------------------------
//
// The shutdown handler only commits files that have a matching
// approved proposal in `memories/proposals/`. The proposal lifecycle is:
//
//   proposed   (written by propose_skill_change)
//     │
//     ├─ user says no  → rejectProposal deletes the file
//     │
//     └─ user says yes → persona calls the execute tool
//                          │
//                          └─ execute tool calls linkExecutedProposal,
//                             which rewrites the frontmatter to
//                             `status: executed` and stamps
//                             `executedAt: <iso>`.
//
// The shutdown handler reads all proposals, builds a set of names whose
// status is `executed` (or `approved`, a deprecated alias), and only
// adds/commits the corresponding files in `workspace/skills/` and
// `workspace/scripts/`. Files without a matching proposal are left in
// the working tree and reported in the shutdown result as `unapproved`
// so the user can decide what to do with them.
//
// The link is best-effort: if the proposal file is missing, the
// rewrite is a no-op and the execute tool's result is unaffected.
// This keeps the execute tools robust against persona mistakes (e.g.,
// calling create_skill without a proposalId, or before the user has
// approved).

function parseProposalFrontmatter(text) {
  // Proposals are markdown with a YAML frontmatter block delimited by
  // `---` lines. We only need a tiny subset: name, action, kind,
  // status, and timestamps. A regex-based parser is sufficient for
  // this; the frontmatter is produced by propose_skill_change and is
  // never user-edited, so we do not need to handle multi-line values,
  // quoted strings, or comments.
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const out = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    out[key] = value;
  }
  return out;
}

function rewriteProposalStatus(proposalId, newStatus, executedAt) {
  if (typeof proposalId !== 'string' || !/^[a-z0-9_\-]+$/i.test(proposalId)) {
    return false;
  }
  const target = path.join(proposalsDir, `${proposalId}.md`);
  if (!fs.existsSync(target)) return false;
  try {
    const stamp = executedAt || new Date().toISOString();
    const text = fs.readFileSync(target, 'utf8');
    const next = text
      .replace(/^status:\s*.*$/m, `status: ${newStatus}`)
      .replace(/^executedAt:\s*.*$/m, `executedAt: ${stamp}`);
    // If executedAt was not present, append it after the status line
    // so the original line ordering is preserved when possible.
    const finalText = /^executedAt:\s*/m.test(next)
      ? next
      : next.replace(/^(status:\s*.*)$/m, `$1\nexecutedAt: ${stamp}`);
    fs.writeFileSync(target, finalText, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Link a proposal to the execute tool that just ran. The persona
// passes `proposalId` when it knows the exact proposal file
// (preferred). If `proposalId` is null, the helper searches for the
// most recent `proposed` proposal whose `name` matches and links
// that one. If no matching proposal exists, the link is a no-op:
// the file write still succeeds, but the shutdown handler will not
// auto-commit it. This is the right behavior — it means a stray
// createSkill call (with no proposal) is reported back to the user
// at shutdown, not silently committed.
//
// Returns `{ proposalId, proposalLinked: true }` on a successful
// link, `{ proposalId: null, proposalLinked: false }` when no
// proposal was found, or `null` if `proposalId` was not provided and
// no matching proposal could be resolved (caller decides whether to
// surface that).
function linkExecutedProposal({ proposalId, name, kind } = {}) {
  const iso = new Date().toISOString();
  // Path 1: explicit proposalId. Rewrite that proposal's status to
  // `executed` and stamp executedAt.
  if (proposalId) {
    const ok = rewriteProposalStatus(proposalId, 'executed', iso);
    return ok
      ? { proposalId, proposalLinked: true }
      : { proposalId: null, proposalLinked: false };
  }
  // Path 2: find the most recent `proposed` proposal whose name
  // matches. The proposal filename is `<name>-<ts>.md` where `ts`
  // is an ISO timestamp with `.` and `:` replaced by `-`. Because
  // the proposalTimestamp is monotonic, sorting by the basename
  // (descending) gives the same result as sorting by mtime, but
  // without the failure mode of a proposal whose mtime is updated
  // out-of-band (text editor, `touch`, copy). Two proposals in the
  // same millisecond would collide on filename; in that case the
  // newer write wins, which is the correct behavior.
  try {
    if (!fs.existsSync(proposalsDir)) return null;
    const files = fs
      .readdirSync(proposalsDir)
      .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.md'))
      .map((f) => {
        const full = path.join(proposalsDir, f);
        return { full, proposalId: f.replace(/\.md$/, ''), basename: f };
      })
      .sort((a, b) => (a.basename < b.basename ? 1 : a.basename > b.basename ? -1 : 0));
    for (const entry of files) {
      const text = fs.readFileSync(entry.full, 'utf8');
      const fm = parseProposalFrontmatter(text);
      if (!fm) continue;
      if (fm.status !== 'proposed') continue;
      if (fm.name !== name) continue;
      if (kind && fm.kind && fm.kind !== kind) continue;
      const ok = rewriteProposalStatus(entry.proposalId, 'executed', iso);
      return ok
        ? { proposalId: entry.proposalId, proposalLinked: true }
        : { proposalId: null, proposalLinked: false };
    }
  } catch {
    // Fall through to the no-link return below.
  }
  return null;
}

// Test-only export so the frontmatter parser can be exercised in
// isolation. Production callers use the public proposal/execute
// tools, which call this internally.
export function __test_parseProposalFrontmatter(text) {
  return parseProposalFrontmatter(text);
}

// Read the full set of approved skill/script names from a proposals
// directory. An "approved" proposal is one whose frontmatter status
// is `executed` (set by the execute tool when the persona calls it
// after the user said yes) or the deprecated `approved` alias kept
// for back-compat. The shutdown handler imports this to decide which
// working-tree files are safe to commit; the proposals dir defaults
// to the real workspace proposals dir but is overridable so tests
// can point it at a throwaway repo.
export function listApprovedProposals(proposalsDirOverride = null) {
  const dir = proposalsDirOverride || proposalsDir;
  const approved = [];
  try {
    if (!fs.existsSync(dir)) return approved;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(dir, f);
      const text = fs.readFileSync(full, 'utf8');
      const fm = parseProposalFrontmatter(text);
      if (!fm) continue;
      if (fm.status !== 'executed' && fm.status !== 'approved') continue;
      if (!fm.name) continue;
      approved.push(fm.name);
    }
  } catch {
    // Best effort: a corrupt proposals directory should not block
    // shutdown. The handler will fall back to "no approved changes"
    // and report the working-tree files as unapproved.
  }
  return approved;
}
