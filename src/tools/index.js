// Tool registry for MineAgent.
//
// The five vision-mandated connection tools live alongside the speak
// tool, the shutdown tool, and the self-improvement tools. The agent
// loop iterates over the `tools` array to render help, validate input,
// and dispatch invocations. The shape is:
//
//   { name, description, parameters, execute(args) -> Promise<Result> }

import {
  connectToServer,
  disconnectFromServer,
  sendChat,
  getStatus,
} from '../connection.js';
import { state, setStatus } from '../state.js';
import { speak } from '../speak.js';
import { shutdown, writeSessionSummary, commitImprovements } from '../shutdown.js';
import {
  createSkill,
  createScript,
  writeMemory,
  listSkills,
  listScripts,
  listMemories,
} from '../improve.js';
import { subscribe } from '../events.js';

const stringParam = (description) => ({ type: 'string', required: false, description });
const requiredStringParam = (description) => ({
  type: 'string',
  required: true,
  description,
});

export const tools = [
  {
    name: 'connect_to_server',
    description:
      'Start a Mineflayer connection given a host, port, and username. Reports success, failure, or a specific error.',
    parameters: {
      host: requiredStringParam('Server hostname or IP address.'),
      port: { type: 'number', required: false, description: 'Server port. Default 25565.' },
      username: stringParam('In-game username. Defaults to the configured username.'),
    },
    execute: async ({ host, port, username } = {}) => {
      return connectToServer({ host, port, username });
    },
  },
  {
    name: 'disconnect_from_server',
    description: 'Clean shutdown of the current connection.',
    parameters: {},
    execute: async () => disconnectFromServer(),
  },
  {
    name: 'set_username',
    description: 'Override the username used for the next connect.',
    parameters: { username: requiredStringParam('New default username.') },
    execute: async ({ username } = {}) => {
      if (!username) {
        return { ok: false, error: 'username is required' };
      }
      state.config.username = username;
      return { ok: true, username: state.config.username };
    },
  },
  {
    name: 'connection_status',
    description:
      'Report the current connection state (connected, disconnected, reconnecting, error).',
    parameters: {},
    execute: async () => ({ ok: true, ...getStatus() }),
  },
  {
    name: 'ask_user_for_server',
    description:
      'Prompt the user for the IP/port or other connection details the agent is missing.',
    parameters: {},
    execute: async () => ({
      ok: true,
      prompt: "Hey, what's the IP address? (or 'IP and port?')",
    }),
  },
  {
    name: 'speak',
    description: 'Say a line out loud through the browser observer (TTS).',
    parameters: { text: requiredStringParam('Text to speak.') },
    execute: async ({ text } = {}) => speak(text),
  },
  {
    name: 'shutdown',
    description:
      'Stop the bot, write a session summary into memories/, and attempt to commit any promoted improvements to skills/ or scripts/.',
    parameters: {
      exitReason: stringParam('Why the bot is shutting down.'),
    },
    execute: async ({ exitReason } = {}) => shutdown({ exitReason }),
  },
  {
    name: 'create_skill',
    description:
      'Write a new file into workspace/skills/. Use kind=code to write a .js file, kind=doc to write a .md file.',
    parameters: {
      name: requiredStringParam('Alphanumeric name for the skill (a-z 0-9 _ -).'),
      body: requiredStringParam('File body to write.'),
      kind: { type: 'string', required: false, description: '"doc" (default) or "code".' },
    },
    execute: async ({ name, body, kind } = {}) => createSkill({ name, body, kind }),
  },
  {
    name: 'create_script',
    description: 'Write a helper script into workspace/scripts/.',
    parameters: {
      name: requiredStringParam('Alphanumeric name for the script (a-z 0-9 _ -).'),
      body: requiredStringParam('File body to write.'),
    },
    execute: async ({ name, body } = {}) => createScript({ name, body }),
  },
  {
    name: 'write_memory',
    description:
      'Write a note into workspace/memories/ (gitignored, not committed).',
    parameters: {
      name: requiredStringParam('Alphanumeric name for the memory file.'),
      body: requiredStringParam('File body to write.'),
    },
    execute: async ({ name, body } = {}) => writeMemory({ name, body }),
  },
  {
    name: 'list_skills',
    description: 'List the files currently in workspace/skills/.',
    parameters: {},
    execute: async () => ({ ok: true, skills: listSkills() }),
  },
  {
    name: 'list_scripts',
    description: 'List the files currently in workspace/scripts/.',
    parameters: {},
    execute: async () => ({ ok: true, scripts: listScripts() }),
  },
  {
    name: 'list_memories',
    description: 'List the files currently in workspace/memories/.',
    parameters: {},
    execute: async () => ({ ok: true, memories: listMemories() }),
  },
];

export function findTool(name) {
  return tools.find((t) => t.name === name) || null;
}

export function findToolsByPrefix(prefix) {
  return tools.filter((t) => t.name.startsWith(prefix));
}

export { subscribe };
