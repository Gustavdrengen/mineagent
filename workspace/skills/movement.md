# movement

## Purpose

Move the bot to a destination in the world, follow another player, or stop in place.

## When to use

- The user names coordinates (e.g. "go to 100, 64, -200").
- The user names another player to follow.
- The user names a landmark (a structure, a biome) that the bot can resolve to coordinates via exploration or memory.
- The bot needs to stop what it is doing and idle.

## Tools

- `move_to({ x, y, z, tolerance })` — pathfind and walk to a coordinate. `tolerance` defaults to 1 block. Returns when the bot arrives, fails on "no path found", or fails on disconnect.
- `stop_moving({})` — cancel the current pathfinder goal and any active follow loop. Resolves immediately.
- `follow_player({ username, durationMs })` — follow a named player for up to `durationMs` (default 30s). Re-issues the pathfinder goal toward the player every 500ms.
- `look_at_block({ x, y, z })` — turn the bot's head to a specific block. Returns the block name.
- `look_at_position({ x, y, z })` — turn the bot's head to an arbitrary point in the world (the sky, an entity, a spot the cursor is pointing at).

## Outputs

- `move_to` → `{ ok, arrivedAt: { x, y, z }, pathLength }` on success, or `{ ok: false, error }` on failure.
- `follow_player` → `{ ok, stopped: true, reason: 'duration reached' }` when the duration is reached, or `{ ok: false, error }` on failure.
- `stop_moving` → `{ ok: true }`.
- `look_at_block` → `{ ok, block: { name, position } | null }`.
- `look_at_position` → `{ ok, position: { x, y, z } }`.

## Failure modes

- `not_connected` — the bot is not in a world.
- `coords_invalid` — `x`, `y`, or `z` is not a finite number.
- `no_path` — the pathfinder could not route to the destination.
- `disconnected_mid_path` — the connection dropped while the bot was moving.

## Example

```js
// Walk to coordinates, then look at a block on arrival
const r = await callTool('move_to', { x: 100, y: 64, z: -200 });
if (r.ok) {
  await callTool('send_chat', { text: `Arrived at ${r.arrivedAt.x}, ${r.arrivedAt.y}, ${r.arrivedAt.z}.` });
  await callTool('look_at_block', { x: 100, y: 64, z: -200 });
} else {
  await callTool('send_chat', { text: `Could not reach: ${r.error}` });
}
```
