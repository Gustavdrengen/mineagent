# movement

## Purpose

Move the bot to a destination in the world.

## When to use

- The user names coordinates (e.g. "go to 100, 64, -200").
- The user names another player to follow.
- The user names a landmark (a structure, a biome) that the bot can resolve to coordinates via exploration or memory.

## Inputs

- `destination` — either `{ x, y, z }` coordinates, a player username, or a landmark string.
- `tolerance` (optional) — how close counts as "arrived." Default 1 block.

## Outputs

- `{ ok, arrivedAt, pathLength, error? }` where `arrivedAt` is the final position and `pathLength` is the number of steps taken.

## Failure modes

- No path found (terrain blocked, no route to destination).
- Destination out of render distance.
- Bot is not connected.

## Example

```js
// walk to coordinates
const result = await movement({ destination: { x: 100, y: 64, z: -200 } });
if (result.ok) {
  bot.chat(`Arrived at ${result.arrivedAt.x}, ${result.arrivedAt.y}, ${result.arrivedAt.z}.`);
} else {
  bot.chat(`Could not reach: ${result.error}`);
}
```
