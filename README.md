# MineAgent

A Minecraft playing agent built on [Mineflayer](https://github.com/PrismarineJS/mineflayer). MineAgent connects to offline-mode Minecraft servers, accepts user goals, observes and acts in the world, talks in chat, speaks through browser TTS, exposes a live observer console, and improves itself over time through skills, scripts, and run-local memories.

The product vision is in [`VISION.md`](./VISION.md) (user-owned, do not edit from inside the agent). The repository operating manual is in [`AGENTS.md`](./AGENTS.md). The current behavior contract is in [`specs/`](./specs).

## Quick start

```bash
npm install
npm run smoke        # verify the entry point loads
npm start            # start the bot (will prompt for server host/port)
npm run observer     # start the browser observer on :3000
```

The bot only connects to servers that run in **offline mode** (no Mojang authentication). If you don't have a server handy, a local one is enough for development:

```bash
# in another terminal
npx --yes minecraft-server --offline
```

## Repository layout

See `AGENTS.md` for the canonical layout. In short: the playing agent lives in `workspace/`. The Mineflayer code, browser observer, and supporting infrastructure live in `src/`, `server/`, and `public/`.

## Development

```bash
npm test     # run the test suite (Node built-in test runner)
npm run dev  # auto-reload the entry point on change
```

## Status

Bootstrap complete. See the current state of play at the bottom of `AGENTS.md`.
