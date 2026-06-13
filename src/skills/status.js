// Status skill for MineAgent.
//
// Reports the bot's position, health, food, inventory, and current task.
// Used by the agent loop to answer "where are you?" / "what are you doing?"
// in chat, and by the observer to render the status panel.

import { state, snapshot } from '../state.js';

function withBot(extras) {
  const bot = state.bot;
  if (!bot) return null;
  return {
    position: bot.entity?.position
      ? {
          x: Math.floor(bot.entity.position.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(bot.entity.position.z),
        }
      : null,
    health: bot.health?.health ?? null,
    food: bot.health?.food ?? null,
    experience: bot.experience?.level ?? null,
    gameMode: bot.game?.gameMode ?? null,
    ...extras,
  };
}

export function status({ include = ['position', 'health', 'inventory', 'task'] } = {}) {
  const wants = new Set(include);
  const out = { ok: true, connected: state.status === 'connected' };
  if (state.status !== 'connected') {
    return { ...out, error: 'not connected' };
  }
  const live = withBot({}) || {};
  if (wants.has('position')) out.position = live.position;
  if (wants.has('health')) {
    out.health = live.health;
    out.food = live.food;
  }
  if (wants.has('inventory')) out.inventory = state.inventory;
  if (wants.has('task')) out.currentTask = state.currentTask;
  return out;
}

export function fullSnapshot() {
  return snapshot();
}
