# status

## Purpose

Report the bot's current state: inventory, health, position, current task.

## When to use

- The user asks "where are you?" or "what's in your inventory?" or "what are you doing?".
- The bot needs to decide whether it is safe to take a new action.
- The observer console needs a snapshot.

## Inputs

- `include` (optional) — subset of `["inventory", "health", "position", "task"]`. Default all.

## Outputs

- `{ ok, inventory?, health?, position?, task?, error? }`.

## Failure modes

- Bot is not connected (most fields are null).
- The requested subset is empty or unknown.

## Example

```js
const s = await status({ include: ['position', 'health'] });
bot.chat(`At ${s.position.x}, ${s.position.y}, ${s.position.z}, health ${s.health}.`);
```
