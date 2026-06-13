// Shared state for the MineAgent connection layer.
//
// This module is the single source of truth for "what is the bot doing right
// now." Every other module in src/ reads from here, and connection.js is the
// only module that writes to it.

export const STATUS = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

export const state = {
  status: STATUS.DISCONNECTED,
  lastError: null,
  config: {
    host: null,
    port: 25565,
    username: 'MineAgent',
  },
  bot: null,
};

export function setStatus(next, error = null) {
  state.status = next;
  state.lastError = error;
}

export function snapshot() {
  return {
    status: state.status,
    host: state.config.host,
    port: state.config.port,
    username: state.config.username,
    lastError: state.lastError,
  };
}
