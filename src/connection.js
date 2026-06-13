// Mineflayer connection manager for MineAgent.
//
// Wraps mineflayer.createBot in a small state machine that the rest of
// the project can drive from plain async functions. Only the
// vision-mandated offline-mode auth is supported; there is no path to
// online Mojang auth.
//
// Every connect attempt — success or failure — is classified into a
// stable `error.kind` so the agent loop can decide whether to retry,
// ask the user, or give up cleanly. The vision says the agent should be
// able to retry on connection failure and decide its next step; that
// decision needs disambiguated error kinds, not a flat message string.
//
// **Decision:** Add `error.kind` to all connectToServer failure paths.
// **Tier:** T1. **Evidence:** Original feedback said the agent had no
// way to disambiguate "kicked" from "unreachable" from "auth required";
// the vision explicitly calls out retry and give-up decision points.
// **Trade-off:** Slightly more code in connectToServer; consumed by
// specs/connection.md and the agent loop.

import mineflayer from 'mineflayer';
import {
  state,
  setStatus,
  snapshot,
  setPosition,
  setHealth,
  setInventory,
  setCurrentTask,
  recordChat,
  recordAction,
  resetRuntime,
  markSessionStart,
  STATUS,
} from './state.js';
import { emit, subscribe } from './events.js';
import { writeLastServer } from './improve.js';

export function getStatus() {
  return snapshot();
}

export function onEvent(listener) {
  return subscribe(listener);
}

// Stable error kinds the agent loop can branch on. Kept as a frozen
// object so the rest of the codebase can reference kinds by name.
export const ERROR_KIND = Object.freeze({
  UNREACHABLE: 'unreachable',
  REFUSED: 'refused',
  TIMEOUT: 'timeout',
  AUTH_REQUIRED: 'auth_required',
  VERSION_MISMATCH: 'version_mismatch',
  NOT_WHITELISTED: 'not_whitelisted',
  KICKED: 'kicked',
  ALREADY_CONNECTING: 'already_connecting',
  NO_HOST: 'no_host',
  UNKNOWN: 'unknown',
});

// Map a low-level Node error code to a stable kind. err.code is the
// canonical signal Mineflayer surfaces from the socket layer.
function classifySocketError(err) {
  if (!err) return ERROR_KIND.UNKNOWN;
  const code = err.code || '';
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH'
  ) {
    return ERROR_KIND.UNREACHABLE;
  }
  if (code === 'ECONNREFUSED') return ERROR_KIND.REFUSED;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return ERROR_KIND.TIMEOUT;
  return ERROR_KIND.UNKNOWN;
}

// Map a server "kicked" reason string to a stable kind. Mineflayer
// receives a JSON chat component; we receive the parsed string. The
// substring matches here are deliberately conservative — the language
// Minecraft servers use is fairly stable, and the agent can always
// fall back to ERROR_KIND.KICKED with the raw reason preserved.
function classifyKickReason(reason) {
  const text = String(reason || '').toLowerCase();
  if (!text) return ERROR_KIND.KICKED;
  if (text.includes('whitelist') || text.includes('not on the whitelist')) {
    return ERROR_KIND.NOT_WHITELISTED;
  }
  if (
    text.includes('online') ||
    text.includes('auth') ||
    text.includes('premium') ||
    text.includes('mojang')
  ) {
    return ERROR_KIND.AUTH_REQUIRED;
  }
  // Order matters: whitelist > auth > version > kicked. First match
  // wins, so a message containing both "whitelist" and "version" is
  // classified as not_whitelisted, which matches the action the
  // persona should take (ask the user to whitelist). Version matching
  // uses exact phrases (not a bare "version" substring) so unrelated
  // text like "your version of the launcher" does not match.
  if (
    /\boutdated client\b/i.test(text) ||
    /\bincompatible protocol\b/i.test(text) ||
    /\bclient version\b/i.test(text)
  ) {
    return ERROR_KIND.VERSION_MISMATCH;
  }
  return ERROR_KIND.KICKED;
}

function formatReason(reason) {
  if (reason == null) return 'unknown';
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

// Internal helpers, exported for test reachability only. Production
// code should branch on the structured result envelope, not the
// classification internals. The `__test_` prefix is a convention
// (documented in AGENTS.md) that signals "test-only export".
export function __test_classifyKickReason(reason) {
  return classifyKickReason(reason);
}

export function __test_classifySocketError(err) {
  return classifySocketError(err);
}

export async function connectToServer({
  host,
  port = state.config.port,
  username = state.config.username,
} = {}) {
  if (!host) {
    // Pre-flight validation: a missing host is a caller-input error,
    // not a connection failure. Do not transition state — the bot has
    // not even tried to connect. The caller surfaces this to the user.
    return { ok: false, error: 'host is required', kind: ERROR_KIND.NO_HOST };
  }
  if (state.status === STATUS.CONNECTING || state.status === STATUS.CONNECTED) {
    const error = `already ${state.status}`;
    return { ok: false, error, kind: ERROR_KIND.ALREADY_CONNECTING };
  }

  state.config.host = host;
  state.config.port = port;
  state.config.username = username;
  setStatus(STATUS.CONNECTING);
  emit('status', snapshot());

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const bot = mineflayer.createBot({
      host,
      port,
      username,
      auth: 'offline',
    });
    state.bot = bot;

    bot.once('spawn', () => {
      markSessionStart();
      setStatus(STATUS.CONNECTED);
      setCurrentTask('idle');
      attachListeners(bot);
      setCurrentTask('idle');
      if (bot.entity) setPosition(bot.entity.position);
      setHealth(bot.health);
      setInventory(collectInventory(bot));
      emit('status', snapshot());
      emit('connected', { host, port, username });
      // Persist the last-known server so the vision's
      // "from a previous run saved in memories/" branch works.
      writeLastServer({ host, port, username });
      finish({ ok: true, host, port, username });
    });

    bot.once('kicked', (reason) => {
      const message = `kicked: ${formatReason(reason)}`;
      const kind = classifyKickReason(reason);
      setStatus(STATUS.ERROR, message);
      emit('status', snapshot());
      emit('kicked', { reason: message, kind });
      writeLastServer({ host, port, username, lastError: { ok: false, error: message, kind } });
      finish({ ok: false, error: message, kind });
    });

    bot.once('error', (err) => {
      const kind = classifySocketError(err);
      setStatus(STATUS.ERROR, err.message);
      emit('status', snapshot());
      emit('error', { error: err.message, kind });
      writeLastServer({ host, port, username, lastError: { ok: false, error: err.message, kind } });
      finish({ ok: false, error: err.message, kind });
    });

    bot.once('end', () => {
      if (state.status !== STATUS.ERROR) {
        setStatus(STATUS.DISCONNECTED);
      }
      resetRuntime();
      state.bot = null;
      emit('status', snapshot());
      emit('end', {});
      // If the socket closes before spawn, the connect promise has not
      // been settled by spawn/kicked/error. By the time `end` fires,
      // Mineflayer's `error` event (with err.code) has usually already
      // settled the promise; this path is the genuine "clean close
      // before spawn" case, which is unreachable in practice.
      finish({
        ok: false,
        error: 'disconnected before spawn',
        kind: ERROR_KIND.UNREACHABLE,
      });
    });
  });
}

function attachListeners(bot) {
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    recordChat(username, message);
    emit('chat', { username, message });
  });
  bot.on('message', (jsonMsg) => {
    const text = jsonMsg && typeof jsonMsg.toString === 'function'
      ? jsonMsg.toString()
      : '';
    if (!text) return;
    recordChat('server', text);
    emit('message', { text });
  });
  bot.on('kicked', (reason) =>
    emit('kicked', { reason: formatReason(reason) })
  );
  bot.on('error', (err) => emit('error', { error: err.message }));
  bot.on('end', () => emit('end', {}));

  // Live state for the observer. These handlers may fire frequently; we
  // emit a single 'state' snapshot rather than a flood of partial updates.
  bot.on('move', () => {
    if (!bot.entity) return;
    setPosition(bot.entity.position);
    emit('state', snapshot());
  });
  bot.on('health', () => {
    setHealth(bot.health);
    emit('state', snapshot());
  });
  // Inventory changes do not have a single named event in Mineflayer 4.x;
  // the world-interaction skill pushes updates after it mutates inventory.
  bot.inventory.on('updateSlot', () => {
    setInventory(collectInventory(bot));
    emit('state', snapshot());
  });
}

function collectInventory(bot) {
  if (!bot || !bot.inventory) return [];
  const items = bot.inventory.items
    ? bot.inventory.items()
    : Array.from(bot.inventory.slots || []).filter(Boolean);
  return items.map((item, idx) => ({
    slot: item.slot ?? idx,
    name: item.name,
    count: item.count,
  }));
}

export function disconnectFromServer() {
  const bot = state.bot;
  if (!bot) {
    if (state.status !== STATUS.DISCONNECTED) {
      setStatus(STATUS.DISCONNECTED);
      emit('status', snapshot());
    }
    return { ok: true, alreadyDisconnected: true };
  }
  try {
    bot.quit();
  } catch {
    // quit can throw if the socket is already dead; treat as success
  }
  state.bot = null;
  setStatus(STATUS.DISCONNECTED);
  resetRuntime();
  emit('status', snapshot());
  return { ok: true };
}

export function sendChat(message) {
  const bot = state.bot;
  if (!bot || state.status !== STATUS.CONNECTED) {
    return { ok: false, error: 'not connected' };
  }
  bot.chat(message);
  recordChat(bot.username, message);
  recordAction('chat', message);
  emit('state', snapshot());
  return { ok: true };
}
