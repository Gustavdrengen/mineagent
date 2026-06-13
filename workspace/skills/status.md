# status

## Purpose

Report the bot's current state: inventory, health, position, current task, and the recent activity around it (chat, nearby entities, the block under the cursor).

## When to use

- The user asks "where are you?" or "what's in your inventory?" or "what are you doing?".
- The bot needs to decide whether it is safe to take a new action.
- The observer console needs a snapshot.

## Tools

- `connection_status({})` — full snapshot: status, host, port, username, position, health, inventory, current task, last error.
- `read_chat_history({ limit })` — last N chat messages (default 20, max 100).
- `scan_nearby_entities({ maxDistance, type })` — list nearby entities, optionally filtered by `type`.
- `get_block_info({ x, y, z })` — the block at a coordinate, useful for describing "what is in front of me".

## Outputs

- `connection_status` → `{ ok, status, host, port, username, position, health, inventory, currentTask, lastError, ... }`.
- `read_chat_history` → `{ ok, messages: [{ ts, from, message }], count }`.
- `scan_nearby_entities` → `{ ok, count, entities: [{ id, name, type, kind, distance, position }] }`.
- `get_block_info` → `{ ok, position, block: { name, type, metadata, hardness, transparent } | null }`.

## Failure modes

- `not_connected` — most tools need a live `state.bot`. `read_chat_history` works even when disconnected (it reads from the shared chat history, not the bot).

## Example

```js
// Answer "where are you and what's around?"
const s = await callTool('connection_status', {});
const recent = await callTool('read_chat_history', { limit: 5 });
const nearby = await callTool('scan_nearby_entities', { maxDistance: 16 });
const pos = s.position;
await callTool('send_chat', {
  text: `At ${pos.x}, ${pos.y}, ${pos.z}. ${nearby.count} entities within 16 blocks. Last chat: ${recent.messages.map((m) => `<${m.from}> ${m.message}`).join('; ')}.`,
});
```
