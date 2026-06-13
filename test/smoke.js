// Standalone smoke check: imports the module graph, lists the registered
// tools, and prints the initial status. Exits 0 on success. This does not
// open a real TCP connection; that requires a reachable offline-mode server.

import { getStatus } from '../src/connection.js';
import { tools } from '../src/tools/index.js';

console.log('[smoke] importing modules…');

const names = tools.map((t) => t.name);
console.log(`[smoke] ${tools.length} tools registered: ${names.join(', ')}`);

for (const required of [
  'connect_to_server',
  'disconnect_from_server',
  'set_username',
  'connection_status',
  'ask_user_for_server',
]) {
  if (!names.includes(required)) {
    console.error(`[smoke] FAIL: missing required tool: ${required}`);
    process.exit(1);
  }
}

console.log('[smoke] initial status:', getStatus());

// Calling connection_status through the tool surface, to confirm the wiring.
const statusTool = tools.find((t) => t.name === 'connection_status');
const statusResult = await statusTool.execute({});
if (!statusResult.ok) {
  console.error('[smoke] FAIL: connection_status returned !ok');
  process.exit(1);
}
if (statusResult.status !== 'disconnected') {
  console.error(`[smoke] FAIL: expected status=disconnected, got ${statusResult.status}`);
  process.exit(1);
}

console.log('[smoke] OK — modules load, state machine is wired, tools register cleanly.');
console.log('[smoke] note: live connect requires a reachable offline-mode Minecraft server.');
