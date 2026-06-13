# inventory

## Purpose

Manage the bot's inventory: equip items for the hand or armor slots, drop items, and use the held item.

## When to use

- The user names a tool the bot should hold ("equip a pickaxe").
- The bot has the wrong item in its hand for an upcoming action.
- The user wants to throw away items ("drop 3 dirt").
- The bot needs to eat, drink, shoot, or right-click an interactable block.

## Tools

- `equip_item({ name, destination })` — equip an item by name. `destination` is one of `hand` (default), `head`, `torso`, `legs`, `feet`, `off-hand`.
- `drop_item({ name, count })` — drop `count` of an item (default 1).
- `use_held_item({})` — right-click with the currently held item. Eats food, shoots bows, activates interactable blocks, throws splash potions, etc.

## Outputs

- `equip_item` → `{ ok, action: 'equip', name, destination }`.
- `drop_item` → `{ ok, action: 'drop', name, count }`.
- `use_held_item` → `{ ok, action: 'use' }`.

## Failure modes

- `not_connected` — the bot is not in a world.
- `item_missing` — the named item is not in the bot's inventory.
- `count_invalid` — `drop_item` got a non-positive `count`.
- `equip_failed` / `drop_failed` / `use_failed` — the underlying Mineflayer call threw; `error` has the message.

## Example

```js
// Hold a pickaxe before mining
await callTool('equip_item', { name: 'iron_pickaxe', destination: 'hand' });
const r = await callTool('mine_block', { name: 'stone', count: 4 });
if (r.ok) {
  await callTool('send_chat', { text: `Mined ${r.blocksTouched} stone.` });
}

// Toss excess dirt
await callTool('drop_item', { name: 'dirt', count: 32 });
```
