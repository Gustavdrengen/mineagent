# Scripts

On-demand helper scripts the MineAgent playing agent can create when a task is too small for a skill but too repetitive to keep re-deriving.

A script is more temporary and more specific than a skill. If a script turns out to be generally useful across sessions, it gets promoted into `../skills/`.

Examples of script-shaped work:

- a one-off refactor of a chunk of `../src/` that the agent needs to coordinate with
- a coordinate-harvesting run over a known region
- a chat-log analyzer for a specific server's format

Anything committed here should still be readable, self-contained, and safe to run.
