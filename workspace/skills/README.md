# Skills

Reusable behavior units for the MineAgent playing agent. One skill per file. A skill describes a thing the agent can do, when to use it, and how to call it.

A skill should be general — any agent on any server should be able to use it. If a behavior is specific to a session or a server, it belongs in `memories/`, not here.

## Index

- [`movement.md`](./movement.md) — walk to coordinates, follow a player, path to a landmark.
- [`chat.md`](./chat.md) — read chat, respond in chat, parse simple commands.
- [`world-interaction.md`](./world-interaction.md) — look at a block, mine a block by name, place a block.
- [`status.md`](./status.md) — inventory, health, position, current task.

## Authoring a new skill

A skill file should have:

1. **Purpose** — one sentence on what the skill is for.
2. **When to use** — concrete situations that call for this skill.
3. **Inputs** — what the caller provides.
4. **Outputs** — what the skill returns.
5. **Failure modes** — what can go wrong and how to surface it.
6. **Example** — a short worked example.
