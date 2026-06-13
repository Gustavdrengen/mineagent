// Mineflayer connection manager for MineAgent.
//
// Wraps mineflayer.createBot in a small state machine that the rest of the
// project can drive from plain async functions. Only the vision-mandated
// offline-mode auth is supported; there is no path to online Mojang auth.

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

export function getStatus() {
  return snapshot();
}

export function onEvent(listener) {
  return subscribe(listener);
}

export async function connectToServer({
  host,
  port = state.config.port,
  username = state.config.username,
} = {}) {
  if (!host) {
    return { ok: false, error: 'host is required' };
  }
  if (state.status === STATUS.CONNECTING || state.status === STATUS.CONNECTED) {
    return { ok: false, error: `already ${state.status}` };
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
      // The `bot.on('spawn', ...)` handler registered by attachListeners
      // would fire for this same spawn and re-emit state; suppress the
      // duplicate by calling setCurrentTask after attachListeners runs.
      setCurrentTask('idle');
      if (bot.entity) setPosition(bot.entity.position);
      setHealth(bot.health);
      setInventory(collectInventory(bot));
      emit('status', snapshot());
      emit('connected', { host, port, username });
      finish({ ok: true, host, port, username });
    });

    bot.once('kicked', (reason) => {
      const message = `kicked: ${formatReason(reason)}`;
      setStatus(STATUS.ERROR, message);
      emit('status', snapshot());
      emit('kicked', { reason: message });
      finish({ ok: false, error: message });
    });

    bot.once('error', (err) => {
      setStatus(STATUS.ERROR, err.message);
      emit('status', snapshot());
      emit('error', { error: err.message });
      finish({ ok: false, error: err.message });
    });

    bot.once('end', () => {
      if (state.status !== STATUS.ERROR) {
        setStatus(STATUS.DISCONNECTED);
      }
      resetRuntime();
      state.bot = null;
      emit('status', snapshot());
      emit('end', {});
      // If the socket closes before spawn, the connect promise has not been
      // settled by spawn/kicked/error, so resolve it here to avoid hanging
      // the caller. finish() is a no-op once another path has settled.
      finish({ ok: false, error: 'disconnected before spawn' });
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

function formatReason(reason) {
  if (reason == null) return 'unknown';
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
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
