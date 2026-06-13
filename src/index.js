#!/usr/bin/env node
// MineAgent CLI entry point.
//
// Parses flags, prompts for host/port if missing, connects, logs status, and
// exits cleanly. The interactive agent loop is layered on in a later commit.

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { connectToServer, disconnectFromServer, getStatus } from './connection.js';
import { state, STATUS } from './state.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' || a === '-h') out.host = argv[++i];
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--username' || a === '-u') out.username = argv[++i];
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
  --help                   Print this help
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

  console.log('[mineagent] connected. Status:', getStatus());
  console.log('[mineagent] type "quit" or "exit" to disconnect. Ctrl-C to abort.');

  // Bootstrap behavior: stay alive on a readline loop until the user types
  // quit/exit (or stdin closes on Ctrl-C / EOF). Shutdown is owned by the
  // 'close' handler so every path through readline ends the same way.
  const rl = readline.createInterface({ input, output });
  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'quit' || cmd === 'exit') {
      rl.close();
    } else if (cmd.length > 0) {
      console.log('[mineagent] unknown command. type "quit" to disconnect.');
    }
  });
  rl.on('close', () => {
    if (state.bot) {
      console.log('[mineagent] shutting down.');
      disconnectFromServer();
    }
  });
}

main().catch((err) => {
  console.error('[mineagent] fatal:', err);
  setStatus(STATUS.ERROR, err.message);
  process.exit(1);
});
