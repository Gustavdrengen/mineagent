// Shared state for the MineAgent connection layer and observer.
//
// This module is the single source of truth for "what is the bot doing right
// now." Every other module in src/ reads from here, and connection.js and
// the agent loop are the only modules that write to it. The HTTP/WebSocket
// observer and the agent loop both read the same snapshot shape.

export const STATUS = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

const MAX_CHAT_HISTORY = 100;
const MAX_VOICE_EVENTS = 50;
const MAX_RECENT_ACTIONS = 50;

export const state = {
  status: STATUS.DISCONNECTED,
  lastError: null,
  config: {
    host: null,
    port: 25565,
    username: 'MineAgent',
  },
  bot: null,
  // Live state for the observer. Populated by connection.js as Mineflayer
  // events fire. Read-only from outside the connection layer.
  position: null, // { x, y, z } | null
  health: null, // { current, max, food } | null
  inventory: [], // [{ name, count, slot }]
  currentTask: null, // string | null
  chatHistory: [], // [{ ts, from, message }]
  voiceEvents: [], // [{ ts, text }]
  recentActions: [], // [{ ts, action, detail }]
  session: {
    startedAt: null,
    lastError: null,
  },
};

export function setStatus(next, error = null) {
  state.status = next;
  state.lastError = error;
  state.session.lastError = error;
}

export function setPosition(position) {
  if (!position) return;
  state.position = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  };
}

export function setHealth(healthObj) {
  if (!healthObj) return;
  state.health = {
    current: typeof healthObj.health === 'number' ? healthObj.health : null,
    max: null,
    food: typeof healthObj.food === 'number' ? healthObj.food : null,
  };
}

export function setInventory(items) {
  state.inventory = Array.isArray(items) ? items.slice() : [];
}

export function setCurrentTask(task) {
  state.currentTask = task || null;
}

export function recordChat(from, message) {
  state.chatHistory.push({
    ts: Date.now(),
    from: from || 'server',
    message: String(message || ''),
  });
  if (state.chatHistory.length > MAX_CHAT_HISTORY) {
    state.chatHistory.splice(0, state.chatHistory.length - MAX_CHAT_HISTORY);
  }
}

export function recordVoice(text) {
  state.voiceEvents.push({ ts: Date.now(), text: String(text || '') });
  if (state.voiceEvents.length > MAX_VOICE_EVENTS) {
    state.voiceEvents.splice(0, state.voiceEvents.length - MAX_VOICE_EVENTS);
  }
}

export function recordAction(action, detail = null) {
  state.recentActions.push({
    ts: Date.now(),
    action: String(action || ''),
    detail: detail == null ? null : String(detail),
  });
  if (state.recentActions.length > MAX_RECENT_ACTIONS) {
    state.recentActions.splice(
      0,
      state.recentActions.length - MAX_RECENT_ACTIONS
    );
  }
}

export function resetRuntime() {
  state.position = null;
  state.health = null;
  state.inventory = [];
  state.currentTask = null;
  state.chatHistory = [];
  state.voiceEvents = [];
  state.recentActions = [];
  state.session.startedAt = null;
}

export function markSessionStart() {
  state.session.startedAt = Date.now();
  state.session.lastError = null;
}

export function snapshot() {
  return {
    status: state.status,
    host: state.config.host,
    port: state.config.port,
    username: state.config.username,
    lastError: state.lastError,
    position: state.position,
    health: state.health,
    inventory: state.inventory,
    currentTask: state.currentTask,
    chatHistory: state.chatHistory.slice(),
    voiceEvents: state.voiceEvents.slice(),
    recentActions: state.recentActions.slice(),
    session: {
      startedAt: state.session.startedAt,
      lastError: state.session.lastError,
    },
  };
}
