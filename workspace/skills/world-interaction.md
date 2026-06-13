# world-interaction

## Purpose

Interact with blocks in the world: find them, look at them, mine them, place them.

## When to use

- The user names a block to mine ("mine 3 oak logs").
- The user names a block to place ("place a torch at my feet").
- The bot needs to inspect the block under its cursor.
- The bot is searching for a specific block type within a radius.

## Tools

- `find_block({ name, maxDistance })` — find the nearest block of a given name within `maxDistance` blocks (default 16). Returns `{ found, position }`.
- `get_block_info({ x, y, z })` — get the block at a coordinate. Returns `{ block: { name, type, metadata, hardness, transparent } | null }`.
- `look_at_block({ x, y, z })` — turn the bot's head to a block. Returns the block name.
- `mine_block({ name, count, range })` — mine a block by name. `count` defaults to 1, `range` defaults to 4. Returns `{ ok, blocksTouched }`.
- `place_block({ name, x, y, z })` — place a block from the bot's inventory at a coordinate. The bot auto-equips the item into the hand.

## Outputs

- `find_block` → `{ ok, found: bool, position: { x, y, z } | null }`.
- `get_block_info` → `{ ok, position, block: { name, type, metadata, hardness, transparent } | null, kind? }`.
- `mine_block` → `{ ok, action: 'mine', blocksTouched: number }`.
- `place_block` → `{ ok, action: 'place', position }`.

## Failure modes

- `not_connected` — the bot is not in a world.
- `unknown_block` — the block name is not in the bot's registry.
- `item_missing` — `place_block` needs an item the bot does not have.
- `name_required` — `mine_block` or `find_block` got an empty `name`.
- `mine_failed` / `place_failed` — the underlying Mineflayer call threw; `error` has the message.

## Example

```js
// Find the nearest oak log, walk to it, mine 3 of them
const r = await callTool('find_block', { name: 'oak_log', maxDistance: 32 });
if (r.found) {
  await callTool('move_to', { x: r.position.x, y: r.position.y, z: r.position.z });
  await callTool('equip_item', { name: 'iron_axe', destination: 'hand' });
  const mined = await callTool('mine_block', { name: 'oak_log', count: 3 });
  if (mined.ok) {
    await callTool('send_chat', { text: `Mined ${mined.blocksTouched} oak logs.` });
  }
}
```
