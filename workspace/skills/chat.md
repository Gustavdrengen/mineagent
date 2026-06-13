# chat

## Purpose

Read player chat, respond in chat, and parse simple commands.

## When to use

- The user says something in chat that needs an answer.
- The user issues a command (e.g. `!come`, `!status`).
- The bot needs to communicate progress or completion to nearby players.

## Inputs

- `message` (optional) — what to say. If omitted, the skill only listens.
- `listenDurationMs` (optional) — how long to listen for the next chat message. Default 0 (one-shot).

## Outputs

- For `listen`: `{ ok, from, message, error? }` describing the next chat line addressed to the bot or anyone.
- For `say`: `{ ok, error? }`.

## Failure modes

- Bot is not connected.
- Server is on a low rate-limit and the bot is throttled.
- Command syntax is unrecognized.

## Example

```js
// respond to a command
const heard = await chat({ listenDurationMs: 5000 });
if (heard.ok && heard.message.startsWith('!come')) {
  const player = heard.message.split(' ')[1];
  await movement({ destination: player });
}
```
