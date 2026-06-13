# chat

## Purpose

Read player chat, respond in chat, and parse simple commands. The persona has exactly one in-world voice: `send_chat`. Every `send_chat` call also triggers browser text-to-speech as an automatic side effect — the agent never calls a separate TTS tool.

## When to use

- The user says something in chat that needs an answer.
- The user issues a command (e.g. `!come`, `!status`).
- The bot needs to communicate progress or completion to nearby players.
- The bot needs to catch up on what was said while it was idle.

## Tools

- `send_chat({ text })` — send a line of text in chat. Auto-plays through the browser observer's TTS as an internal side effect. Returns `{ ok, sent }` or `{ ok: false, kind: 'not_connected' }`.
- `read_chat_history({ limit })` — read the last N messages (default 20, max 100) from the shared chat history.

## Outputs

- `send_chat` → `{ ok, sent: text }` on success, or `{ ok: false, error, kind }` on failure.
- `read_chat_history` → `{ ok, messages: [{ ts, from, message }], count }`.

## Failure modes

- `not_connected` — the bot is not in a world. The voice event is still recorded so the observer sees the attempt.

## Example

```js
// Respond to a command
const heard = await callTool('read_chat_history', { limit: 1 });
if (heard.ok && heard.messages[0]?.message.startsWith('!come')) {
  const player = heard.messages[0].message.split(' ')[1];
  await callTool('follow_player', { username: player });
  await callTool('send_chat', { text: `On my way, ${player}.` });
}
```
