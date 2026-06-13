# combat

## Purpose

Engage hostile mobs and players. The combat skill is intentionally minimal: it exposes one action, `attack_entity`, and expects the agent to use the observation tools to choose the right target and the movement tools to close the distance.

## When to use

- The user names a player or mob to fight.
- The bot is attacked and the persona decides self-defense is appropriate.
- A scripted adventure or quest requires defeating a specific target.

## Tools

- `attack_entity({ username, entityId })` — attack an entity by `username` (player) or `entityId` (any entity, from `scan_nearby_entities`). At least one is required.

## Outputs

- `{ ok, action: 'attack', target }` where `target` is the username or entity id that was attacked.

## Failure modes

- `not_connected` — the bot is not in a world.
- `target_required` — neither `username` nor `entityId` was provided.
- `target_missing` — the named player is not visible; the entity id is unknown.
- `no_position` — the bot has no live `entity.position` yet.
- `attack_failed` — the underlying Mineflayer call threw; `error` has the message.

## Example

```js
// Identify, approach, attack
const nearby = await callTool('scan_nearby_entities', { type: 'mob', maxDistance: 16 });
const zombie = nearby.entities.find((e) => e.name === 'Zombie');
if (zombie) {
  await callTool('equip_item', { name: 'iron_sword', destination: 'hand' });
  await callTool('move_to', { x: zombie.position.x, y: zombie.position.y, z: zombie.position.z });
  await callTool('attack_entity', { entityId: zombie.id });
}
```
