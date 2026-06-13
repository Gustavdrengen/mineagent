// Speak tool for MineAgent.
//
// Records a voice event into the shared state, broadcasts it to every
// connected browser observer (which renders and optionally plays it via the
// Web Speech API), and returns an `ok` envelope. Failures are non-throwing
// so the agent loop can always log a useful error.

import { recordVoice, recordAction, snapshot } from './state.js';
import { emit } from './events.js';

export function speak(text) {
  const message = String(text || '').trim();
  if (!message) {
    return { ok: false, error: 'text is required' };
  }
  recordVoice(message);
  recordAction('speak', message);
  emit('voice', { text: message });
  emit('state', snapshot());
  return { ok: true, text: message };
}
