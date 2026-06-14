#!/usr/bin/env node
// MineAgent CLI entry point.
//
// This is a thin readline wrapper around `startPersona` from
// `src/persona.js`. The single programmatic entry point is the persona
// function; the CLI exists so a human can drive the bot interactively
// from a terminal. OpenCode and the test runner import `startPersona`
// directly and skip this file entirely.

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { startPersona, runGoal, getToolManifest } from './persona.js';
import { shutdown } from './shutdown.js';
import { state, STATUS } from './state.js';
import { disconnectFromServer, getStatus } from './connection.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' || a === '-h') out.host = argv[++i];
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--username' || a === '-u') out.username = argv[++i];
    else if (a === '--goal' || a === '-g') out.goal = argv[++i];
    else if (a === '--print-manifest') out.printManifest = true;
    else if (a === '--help') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: mineagent [options]

Options:
  -h, --host <host>        Minecraft server host
  -p, --port <port>        Minecraft server port (default 25565)
  -u, --username <name>    Bot username (default MineAgent)
  -g, --goal <text>        Run a single goal and exit
  --print-manifest         Print the tool manifest as JSON and exit
  --help                   Print this help

While running, type a goal (e.g. "say hello", "go to 0, 64, 0",
"mine 3 oak_log") and press enter. Type "quit" or "exit" to shut
down cleanly. The agent also responds to in-game chat commands
(!status, !come, !stop, !look, !inventory, !help).

OpenCode and the test runner import startPersona from src/persona.js
and consume getToolManifest() + callTool() directly; no CLI is required.
The MCP server in src/mcp-server.js is the public surface for OpenCode.
`);
}

let cleanupInProgress = false;
async function cleanupAndExit(rl, reason) {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  try {
    const result = await shutdown({ exitReason: reason });
    if (result.summary) {
      console.log(`[mineagent] session summary: ${result.summary}`);
    }
    if (result.commit && result.commit.committed) {
      console.log(`[mineagent] committed: ${result.commit.subject}`);
    } else if (result.commit && result.commit.reason) {
      console.log(`[mineagent] no commit: ${result.commit.reason}`);
    }
  } catch (err) {
    console.error('[mineagent] shutdown error:', err.message);
    if (state.bot) disconnectFromServer();
  }
  if (rl) {
    try { rl.close(); } catch { /* already closed */ }
  }
  process.exit(0);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.printManifest) {
    console.log(JSON.stringify(getToolManifest(), null, 2));
    return;
  }

  // Delegate the entire connect + listener + manifest wiring to
  // startPersona. The CLI only owns the readline loop and shutdown.
  const persona = await startPersona({
    host: opts.host,
    port: opts.port,
    username: opts.username,
    goal: opts.goal,
    prompt: !opts.host, // prompt when no host on the command line
    attachChat: true,
  });

  if (!persona.ok) {
    console.error(`[mineagent] could not start persona: ${persona.error}`);
    if (persona.kind) console.error(`[mineagent] kind: ${persona.kind}`);
    process.exitCode = 1;
    return;
  }

  console.log('[mineagent] connected. Status:', getStatus());
  console.log(
    '[mineagent] type a goal, "quit"/"exit" to shut down, or Ctrl-C to abort.'
  );

  if (opts.goal) {
    // Single-goal mode: runGoal was already invoked by startPersona.
    console.log('[mineagent] goal result:', persona.goalResult);
    await cleanupAndExit(null, 'goal complete');
    return;
  }

  const rl = readline.createInterface({ input, output });
  rl.on('line', async (line) => {
    const cmd = line.trim();
    if (!cmd) return;
    if (cmd.toLowerCase() === 'quit' || cmd.toLowerCase() === 'exit') {
      await cleanupAndExit(rl, 'user requested');
      return;
    }
    try {
      const goalResult = await runGoal(cmd);
      console.log('[mineagent] goal result:', goalResult);
    } catch (err) {
      console.error('[mineagent] goal error:', err.message);
    }
  });
  rl.on('close', () => cleanupAndExit(rl, 'stdin closed'));

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`[mineagent] received ${sig}, shutting down.`);
      cleanupAndExit(rl, `signal ${sig}`).catch(() => process.exit(1));
    });
  }

  void persona;
}

main().catch((err) => {
  console.error('[mineagent] fatal:', err);
  setStatus(STATUS.ERROR, err.message);
  process.exit(1);
});
