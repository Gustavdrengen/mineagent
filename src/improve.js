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

export function updateSkill({ name, body, kind = 'doc' } = {}) {
  // The persona is taught to call propose_skill_change first; this
  // execute tool is the action the persona takes after the user has
  // approved. For now, the implementation is identical to createSkill
  // because the proposal system guarantees the agent does not call
  // this for an existing skill it does not want to overwrite.
  return createSkill({ name, body, kind });
}

export function removeSkill({ name, kind = 'doc' } = {}) {
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
    return { ok: true, path: target, removed: existed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
