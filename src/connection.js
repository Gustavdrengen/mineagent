// Mineflayer connection manager for MineAgent.
//
// Wraps mineflayer.createBot in a small state machine that the rest of the
// project can drive from plain async functions. Only the vision-mandated
// offline-mode auth is supported; there is no path to online Mojang auth.

import mineflayer from 'mineflayer';
import { state, setStatus, snapshot, STATUS } from './state.js';

const listeners = new Set();

export function getStatus() {
  return snapshot();
}

export function onEvent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event, payload) {
  for (const listener of listeners) {
    try {
      listener(event, payload);
    } catch {
      // listener errors must not break the connection loop
    }
  }
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
      setStatus(STATUS.CONNECTED);
      attachListeners(bot);
      emit('connected', { host, port, username });
      finish({ ok: true, host, port, username });
    });

    bot.once('kicked', (reason) => {
      const message = `kicked: ${formatReason(reason)}`;
      setStatus(STATUS.ERROR, message);
      emit('kicked', { reason: message });
      finish({ ok: false, error: message });
    });

    bot.once('error', (err) => {
      setStatus(STATUS.ERROR, err.message);
      emit('error', { error: err.message });
      finish({ ok: false, error: err.message });
    });

    bot.once('end', () => {
      if (state.status !== STATUS.ERROR) {
        setStatus(STATUS.DISCONNECTED);
      }
      state.bot = null;
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
    emit('chat', { username, message });
  });
  bot.on('message', (jsonMsg) => {
    emit('message', { text: jsonMsg.toString() });
  });
  bot.on('kicked', (reason) => emit('kicked', { reason: formatReason(reason) }));
  bot.on('error', (err) => emit('error', { error: err.message }));
  bot.on('end', () => emit('end', {}));
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
  return { ok: true };
}

export function sendChat(message) {
  const bot = state.bot;
  if (!bot || state.status !== STATUS.CONNECTED) {
    return { ok: false, error: 'not connected' };
  }
  bot.chat(message);
  return { ok: true };
}
