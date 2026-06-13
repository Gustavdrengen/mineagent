# world-interaction

## Purpose

Interact with blocks in the world: look at them, mine them, place them.

## When to use

- The user names a block to mine ("mine 3 oak logs").
- The user names a block to place ("place a torch at my feet").
- The bot needs to inspect the block under its cursor.

## Inputs

- `action` — `"look" | "mine" | "place"`.
- `target` — for `mine`, a block name or a position; for `place`, a block name and a position; for `look`, a position.
- `count` (optional) — how many blocks to mine. Default 1.

## Outputs

- `{ ok, action, blocksTouched, error? }`.

## Failure modes

- Target block is not in render distance.
- Required tool is missing from the inventory.
- Block is unbreakable in the current game mode.
- The named block is unknown.

## Example

```js
// mine 3 oak logs in front of the bot
const r = await worldInteraction({ action: 'mine', target: 'oak_log', count: 3 });
if (r.ok) bot.chat(`Mined ${r.blocksTouched} blocks.`);
```
