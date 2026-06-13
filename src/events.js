// In-process pub/sub for MineAgent.
//
// This module is the single emitter for everything the connection layer,
// the agent loop, the speak tool, and the WebSocket observer need to react
// to. Modules subscribe with `subscribe(listener)` and receive every
// `(event, payload)` pair emitted anywhere in the project. Errors thrown
// by a listener are caught and ignored so one bad subscriber cannot break
// the rest of the system.

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(event, payload) {
  for (const listener of listeners) {
    try {
      listener(event, payload);
    } catch {
      // listener errors must not break the connection loop
    }
  }
}

export function clear() {
  listeners.clear();
}
