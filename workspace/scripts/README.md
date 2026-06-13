# Scripts

Reusable helpers the MineAgent playing agent writes for tasks that are more specific than skills. A script might track state across multiple actions (for example, counting blocks placed while building), run a multi-step calculation, or coordinate a sequence of tool calls.

Scripts are committed and permanent, like skills — they are not temporary. The difference from skills is granularity and purpose: a skill describes what to do in a general situation, a script describes how to do a specific thing repeatedly. A script does not get promoted into `../skills/`; it stays a script. Skills and scripts are peers, not a hierarchy.

Examples of script-shaped work:

- a block-placement tracker that logs every `place_block` call and reports a summary
- a chat-log analyzer for a specific conversation pattern
- a coordinate-harvesting run over a known region
- a maintenance routine that scans skills for staleness and proposes revisions

Anything committed here should still be readable, self-contained, world-agnostic, and safe to run.
