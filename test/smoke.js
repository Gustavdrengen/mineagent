// Standalone smoke check: imports the full module graph (state, events,
// connection, tools, speak, agent, shutdown, improve, skills) and prints
// a structured readiness report. Exits 0 on success, 1 on failure.
//
// This does NOT open a TCP connection; that requires a reachable
// offline-mode Minecraft server and is intentionally out of scope for
// the smoke check. Run it with `npm run smoke`.

import fs from 'node:fs';
import { getStatus } from '../src/connection.js';
import { tools, findTool } from '../src/tools/index.js';
import { state, snapshot, STATUS } from '../src/state.js';
import { subscribe, emit } from '../src/events.js';
import { speak } from '../src/speak.js';
import { runGoal, attachChatListener, getActiveGoal } from '../src/agent.js';
import { shutdown, commitImprovements } from '../src/shutdown.js';
import {
  createSkill,
  createScript,
  writeMemory,
  listSkills,
  listScripts,
  listMemories,
} from '../src/improve.js';
import {
  moveToCoordinates,
  stopMoving,
} from '../src/skills/movement.js';
import { status } from '../src/skills/status.js';
import { parseCommand, handleCommand } from '../src/skills/chat.js';

let failed = false;
function check(label, cond, detail) {
  if (cond) {
    console.log(`[smoke] ok   — ${label}`);
  } else {
    failed = true;
    console.error(`[smoke] FAIL — ${label}${detail ? `: ${detail}` : ''}`);
  }
}

console.log('[smoke] importing modules…');

const names = tools.map((t) => t.name);
console.log(`[smoke] ${tools.length} tools registered: ${names.join(', ')}`);

for (const required of [
  'connect_to_server',
  'disconnect_from_server',
  'set_username',
  'connection_status',
  'ask_user_for_server',
  'speak',
  'shutdown',
  'create_skill',
  'create_script',
  'write_memory',
  'list_skills',
  'list_scripts',
  'list_memories',
]) {
  check(`required tool: ${required}`, names.includes(required));
}

check('status is DISCONNECTED initially', state.status === STATUS.DISCONNECTED);

const snap = snapshot();
check(
  'initial snapshot has all vision-mandated keys',
  [
    'status', 'host', 'port', 'username', 'lastError',
    'position', 'health', 'inventory', 'currentTask',
    'chatHistory', 'voiceEvents', 'recentActions', 'session',
  ].every((k) => k in snap)
);

check('connection_status through tool returns ok', (await findTool('connection_status').execute({})).ok === true);

const emptySpeak = await speak('   ');
check('speak with empty text returns !ok', emptySpeak.ok === false);

const speakResult = speak('smoke-test');
check(
  'speak with text records a voice event',
  speakResult.ok === true && state.voiceEvents[state.voiceEvents.length - 1].text === 'smoke-test'
);

const parsed = parseCommand('!status please');
check('chat parseCommand on "!status please"', parsed && parsed.name === '!status' && parsed.args[0] === 'please');

const helpResult = await runGoal('help');
check('runGoal("help") returns a help list', helpResult.ok && Array.isArray(helpResult.help) && helpResult.help.length > 0);

const sayResult = await runGoal('say hello');
check('runGoal("say hello") records voice + chat', sayResult.ok && sayResult.said === 'hello');

state.bot = null;
const goResult = await runGoal('go to 1, 2, 3');
check('runGoal("go to 1, 2, 3") without a bot returns !ok', goResult.ok === false);

const skillFile = createSkill({ name: 'smoke-test-skill', body: 'x' });
check('self-improvement create_skill writes a file', skillFile.ok && fs.existsSync(skillFile.path));
if (skillFile.ok) {
  check('list_skills includes the new file', listSkills().includes(skillFile.path));
  fs.unlinkSync(skillFile.path);
}

const scriptFile = createScript({ name: 'smoke-test-script', body: 'y' });
check('self-improvement create_script writes a file', scriptFile.ok && fs.existsSync(scriptFile.path));
if (scriptFile.ok) {
  check('list_scripts includes the new file', listScripts().includes(scriptFile.path));
  fs.unlinkSync(scriptFile.path);
}

const memoryFile = writeMemory({ name: 'smoke-test-memo', body: 'z' });
check('self-improvement write_memory writes a file', memoryFile.ok && fs.existsSync(memoryFile.path));
if (memoryFile.ok) {
  check('list_memories includes the new file', listMemories().includes(memoryFile.path));
  fs.unlinkSync(memoryFile.path);
}

const off = attachChatListener();
check('attachChatListener returns an unsubscribe function', typeof off === 'function');
off();

const commitResult = await commitImprovements();
check(
  'commitImprovements is a no-op when nothing in skills/scripts changed',
  commitResult.ok && commitResult.committed === false
);

const stopResult = stopMoving();
check('stopMoving returns a structured result', stopResult && typeof stopResult === 'object');

const statusCheck = status();
check('status() returns a structured snapshot', statusCheck && typeof statusCheck === 'object');

const handleResult = await handleCommand({ from: 'tester', message: '!nope' });
check('handleCommand on unknown command returns not-handled', handleResult.handled === false);

const subscriberReceived = [];
const offSub = subscribe((event, payload) => subscriberReceived.push({ event, payload }));
emit('smoke-test', { ok: true });
offSub();
check(
  'in-process event bus delivers payloads',
  subscriberReceived.length === 1 && subscriberReceived[0].event === 'smoke-test'
);

const activeGoal = getActiveGoal();
check('getActiveGoal returns null when idle', activeGoal === null);

if (failed) {
  console.error('[smoke] FAIL — at least one check did not pass.');
  process.exit(1);
}
console.log('[smoke] OK — modules load, state machine is wired, tools register, agent loop and shutdown handler are ready.');
console.log('[smoke] note: live connect requires a reachable offline-mode Minecraft server.');

// shutdown() touches runtime state; skip it in the smoke check to keep
// the run idempotent. It is exercised by the dedicated shutdown test
// suite (`test/shutdown.test.js`).
process.exit(0);
