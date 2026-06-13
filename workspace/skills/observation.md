# observation

## Purpose

Observe the world and the conversation without acting. Read the recent chat, scan for nearby entities, inspect a block, find a block, and look at an arbitrary point.

## When to use

- The user asks "who is nearby?" or "what is in front of me?" or "what was said in chat?".
- The bot needs to decide whether to engage before committing to a movement or combat action.
- The bot is catching up after a long idle period and wants a recent-chat recap.

## Tools

- `read_chat_history({ limit })` — last N messages from the shared chat history (default 20, max 100).
- `scan_nearby_entities({ maxDistance, type })` — list nearby entities, optionally filtered by `type` (`all` / `player` / `mob` / `object` / `hostile` / `passive`).
- `get_block_info({ x, y, z })` — block name, type, and metadata at a coordinate. Returns `block: null` if there is no block at the position.
- `find_block({ name, maxDistance })` — nearest block of a given name within range; returns the position or `found: false`.
- `look_at_position({ x, y, z })` — turn the bot's head to an arbitrary point in the world.

## Outputs

- `read_chat_history` → `{ ok, messages: [{ ts, from, message }], count }`.
- `scan_nearby_entities` → `{ ok, count, entities: [{ id, name, type, kind, distance, position }] }`.
- `get_block_info` → `{ ok, position, block: { name, type, metadata, hardness, transparent } | null, kind? }`.
- `find_block` → `{ ok, found: bool, position: { x, y, z } | null }`.
- `look_at_position` → `{ ok, position: { x, y, z } }`.

## Failure modes

- `not_connected` — the bot is not in a world. Observation tools that need a live `state.bot` return this; `read_chat_history` works even when disconnected.
- `coords_invalid` — `x`, `y`, or `z` is not a finite number.
- `unknown_block` — `find_block` and `get_block_info` cannot resolve the block name against the bot's registry.
- `name_required` — `find_block` and `get_block_info` need a non-empty `name`.

## Example

```js
// Look around before engaging
const mobs = await callTool('scan_nearby_entities', { type: 'mob', maxDistance: 16 });
if (mobs.count > 0) {
  await callTool('get_block_info', { x: 0, y: 64, z: 0 });
  const recent = await callTool('read_chat_history', { limit: 5 });
  await callTool('send_chat', { text: `I see ${mobs.count} mobs. Recent chat: ${recent.messages.map(m => m.from).join(', ')}.` });
}
```
