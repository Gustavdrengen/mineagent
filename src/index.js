#!/usr/bin/env node
// MineAgent CLI entry point.
//
// Parses flags, prompts for host/port if missing, connects, attaches the
// agent loop, and stays alive on a readline loop. Each non-empty line
// other than `quit`/`exit` is dispatched to the agent as a goal; the
// result is logged and spoken (the speak tool handles TTS).
//
// Shutdown: any of EOF, "quit", "exit", or SIGINT/SIGTERM triggers
// `src/shutdown.js`, which writes a session summary, attempts a commit
// of promoted improvements, and disconnects cleanly.

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  connectToServer,
  disconnectFromServer,
  getStatus,
} from './connection.js';
import { state, STATUS } from './state.js';
import { attachChatListener, runGoal } from './agent.js';
import { shutdown } from './shutdown.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' || a === '-h') out.host = argv[++i];
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--username' || a === '-u') out.username = argv[++i];
    else if (a === '--goal' || a === '-g') out.goal = argv[++i];
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
  --help                   Print this help

While running, type a goal (e.g. "say hello", "go to 0, 64, 0",
"mine 3 oak_log") and press enter. Type "quit" or "exit" to shut
down cleanly. The agent also responds to in-game chat commands
(!status, !come, !stop, !look, !inventory, !help).
`);
}

async function promptForServer() {
  const rl = readline.createInterface({ input, output });
  try {
    const host = (await rl.question('Server host (IP or hostname): ')).trim();
    const portRaw = (await rl.question('Server port [25565]: ')).trim();
    const port = portRaw ? Number(portRaw) : 25565;
    return { host: host || null, port };
  } finally {
    rl.close();
  }
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

  const username = opts.username || state.config.username;
  let { host, port = state.config.port } = opts;

  if (!host) {
    const prompted = await promptForServer();
    host = prompted.host;
    port = prompted.port;
  }
  if (!host) {
    console.error('[mineagent] no host provided.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `[mineagent] connecting to ${host}:${port} as ${username} (offline mode)...`
  );
  const result = await connectToServer({ host, port, username });

  if (!result.ok) {
    console.error(`[mineagent] connection failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  const off = attachChatListener();
  console.log('[mineagent] connected. Status:', getStatus());
  console.log(
    '[mineagent] type a goal, "quit"/"exit" to shut down, or Ctrl-C to abort.'
  );

  // Single-goal mode: run the goal and exit.
  if (opts.goal) {
    const goalResult = await runGoal(opts.goal);
    console.log('[mineagent] goal result:', goalResult);
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

  // The chat listener lives for the lifetime of the process and is
  // shut down by the disconnect path in cleanupAndExit. The unsubscribe
  // is intentionally not called on `beforeExit` because that hook never
  // fires once cleanupAndExit calls process.exit(0).
  void off;
}

main().catch((err) => {
  console.error('[mineagent] fatal:', err);
  setStatus(STATUS.ERROR, err.message);
  process.exit(1);
});
