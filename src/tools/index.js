// Tool registry for MineAgent.
//
// Every tool in MineAgent is described in a single, harness-agnostic shape:
//
//   {
//     name:        string,        // unique identifier
//     description: string,        // natural-language description for the LLM
//     parameters:  JSON Schema object  // strict subset: { type, properties, required, additionalProperties }
//     execute:     async (args) => { ok, ... }
//   }
//
// The `parameters` shape is the convergence point across MCP, OpenAI
// function calling, Anthropic tool use, and Gemini function calling. It is
// a strict JSON Schema subset (Draft 2020-12 compatible):
//
//   {
//     "type": "object",
//     "additionalProperties": false,
//     "properties": { ... per-arg JSON Schemas ... },
//     "required": [ ... arg names ... ]
//   }
//
// No provider-specific envelope is used here. `getToolManifest()` projects
// the registry into a manifest suitable for any harness; thin adapter
// layers (not shipped in this repo) can wrap it for OpenAI's
// `{type:"function", function:{...}}`, Anthropic/MCP's `input_schema`
// rename, etc.
//
// **Decision:** Tool descriptor shape — JSON Schema subset with
// `name`/`description`/`parameters`/`execute`. **Tier:** T1.
// **Evidence:** Research across MCP, OpenAI, Anthropic, Gemini converges
// on this exact shape. **Trade-off:** None — this is the strict
// intersection, not a custom format, so it loses nothing and gains
// portability.

import {
  connectToServer,
  disconnectFromServer,
  sendChat,
  getStatus,
} from '../connection.js';
import { state } from '../state.js';
import { speak } from '../speak.js';
import { shutdown, writeSessionSummary, commitImprovements } from '../shutdown.js';
import {
  createSkill,
  createScript,
  writeMemory,
  readLastServer,
  clearLastServer,
  listSkills,
  listScripts,
  listMemories,
} from '../improve.js';
import { subscribe } from '../events.js';

// JSON Schema parameter descriptors. These are the building blocks every
// tool in MineAgent composes from. They use the strict subset every
// modern harness accepts.

export const PARAM = {
  string: (description, { required = false, enum: enumValues } = {}) => {
    const out = { type: 'string', description };
    if (enumValues) out.enum = enumValues;
    if (required) out._required = true; // consumed by buildParameters()
    return out;
  },
  number: (description, { required = false } = {}) => {
    const out = { type: 'number', description };
    if (required) out._required = true;
    return out;
  },
  boolean: (description, { required = false } = {}) => {
    const out = { type: 'boolean', description };
    if (required) out._required = true;
    return out;
  },
};

// Build the strict JSON Schema object that harness manifests expect. The
// `required` array is derived from the `_required` markers each PARAM
// helper attached, then the markers are stripped so they don't leak into
// the wire format.
export function buildParameters(fields) {
  const properties = {};
  const required = [];
  for (const [key, schema] of Object.entries(fields || {})) {
    const { _required, ...rest } = schema;
    properties[key] = rest;
    if (_required) required.push(key);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

// The vision-mandated connection tools plus everything the in-world
// persona needs: speak, shutdown, self-improvement, and the optional
// "connect to the last server I remember" tool that honors the vision's
// "from a previous run saved in memories/" branch.

export const tools = [
  {
    name: 'connect_to_server',
    description:
      'Start a Mineflayer connection given a host, port, and username. ' +
      'Reports success or a structured error with a stable error.kind ' +
      '(unreachable, refused, timeout, auth_required, version_mismatch, ' +
      'not_whitelisted, kicked, no_host, already_connecting, unknown). ' +
      'MineAgent only connects to offline-mode servers; if the server ' +
      'requires Mojang auth, error.kind will be "auth_required". ' +
      'Every attempt (success or failure) updates memories/last-server.json.',
    parameters: buildParameters({
      host: PARAM.string('Server hostname or IP address.', { required: true }),
      port: PARAM.number('Server port. Defaults to 25565.'),
      username: PARAM.string(
        'In-game username. Defaults to the configured username (MineAgent).'
      ),
    }),
    execute: async ({ host, port, username } = {}) => {
      // The connection layer persists the last-known server on every
      // attempt (success or failure), so the tool layer does not need
      // to duplicate that work.
      return connectToServer({ host, port, username });
    },
  },
  {
    name: 'disconnect_from_server',
    description: 'Clean shutdown of the current Mineflayer connection.',
    parameters: buildParameters({}),
    execute: async () => disconnectFromServer(),
  },
  {
    name: 'set_username',
    description:
      'Override the username used for the next connect. ' +
      'Must be a non-empty string.',
    parameters: buildParameters({
      username: PARAM.string('New default username.', { required: true }),
    }),
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
      'Report the current connection state. Returns the live snapshot ' +
      'with status, host, port, username, position, health, inventory, ' +
      'current task, and last error.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, ...getStatus() }),
  },
  {
    name: 'ask_user_for_server',
    description:
      'Return a prompt the calling layer can present to the user when ' +
      'the agent does not know the server IP/port. The MineAgent CLI ' +
      'presents this prompt and feeds the answer back to ' +
      'connect_to_server.',
    parameters: buildParameters({}),
    execute: async () => ({
      ok: true,
      prompt: "Hey, what's the IP address? (or 'IP and port?')",
    }),
  },
  {
    name: 'connect_to_last_known_server',
    description:
      'Read the last server the agent successfully connected to from ' +
      'workspace/memories/last-server.json and connect to it. ' +
      'Implements the vision branch: "from a previous run saved in ' +
      'memories/". If no memory exists, returns ok=false with kind ' +
      '"no_memory".',
    parameters: buildParameters({}),
    execute: async () => {
      const remembered = readLastServer();
      if (!remembered || !remembered.host) {
        return {
          ok: false,
          error: 'no remembered server in memories/',
          kind: 'no_memory',
        };
      }
      return connectToServer({
        host: remembered.host,
        port: remembered.port,
        username: remembered.username,
      });
    },
  },
  {
    name: 'forget_last_server',
    description:
      'Clear the remembered server in workspace/memories/last-server.json. ' +
      'Use this when the user explicitly switches contexts.',
    parameters: buildParameters({}),
    execute: async () => {
      clearLastServer();
      return { ok: true, forgotten: true };
    },
  },
  {
    name: 'speak',
    description:
      'Say a line out loud through the browser observer (TTS). ' +
      'Records a voice event into state and broadcasts it to the ' +
      'WebSocket observer.',
    parameters: buildParameters({
      text: PARAM.string('Text to speak.', { required: true }),
    }),
    execute: async ({ text } = {}) => speak(text),
  },
  {
    name: 'shutdown',
    description:
      'Stop the bot, write a session summary into memories/, and ' +
      'attempt to commit any promoted improvements to skills/ or ' +
      'scripts/. Returns a structured result with the summary path ' +
      'and commit outcome.',
    parameters: buildParameters({
      exitReason: PARAM.string('Why the bot is shutting down.'),
    }),
    execute: async ({ exitReason } = {}) => shutdown({ exitReason }),
  },
  {
    name: 'create_skill',
    description:
      'Write a new file into workspace/skills/. Use kind="code" to ' +
      'write a .js file, kind="doc" (default) to write a .md file.',
    parameters: buildParameters({
      name: PARAM.string(
        'Alphanumeric name for the skill (a-z 0-9 _ -).',
        { required: true }
      ),
      body: PARAM.string('File body to write.', { required: true }),
      kind: PARAM.string('"doc" (default) or "code".', {
        enum: ['doc', 'code'],
      }),
    }),
    execute: async ({ name, body, kind } = {}) =>
      createSkill({ name, body, kind }),
  },
  {
    name: 'create_script',
    description: 'Write a helper script into workspace/scripts/.',
    parameters: buildParameters({
      name: PARAM.string(
        'Alphanumeric name for the script (a-z 0-9 _ -).',
        { required: true }
      ),
      body: PARAM.string('File body to write.', { required: true }),
    }),
    execute: async ({ name, body } = {}) => createScript({ name, body }),
  },
  {
    name: 'write_memory',
    description:
      'Write a note into workspace/memories/ (gitignored, not committed).',
    parameters: buildParameters({
      name: PARAM.string('Alphanumeric name for the memory file.', {
        required: true,
      }),
      body: PARAM.string('File body to write.', { required: true }),
    }),
    execute: async ({ name, body } = {}) => writeMemory({ name, body }),
  },
  {
    name: 'list_skills',
    description: 'List the files currently in workspace/skills/.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, skills: listSkills() }),
  },
  {
    name: 'list_scripts',
    description: 'List the files currently in workspace/scripts/.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, scripts: listScripts() }),
  },
  {
    name: 'list_memories',
    description: 'List the files currently in workspace/memories/.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, memories: listMemories() }),
  },
];

// Public lookup helpers.
export function findTool(name) {
  return tools.find((t) => t.name === name) || null;
}

export function findToolsByPrefix(prefix) {
  return tools.filter((t) => t.name.startsWith(prefix));
}

// Harness-agnostic manifest. Returns a stable list of plain objects with
// the `execute` function stripped — adapters for any LLM harness can
// consume this without binding to MineAgent internals.
export function getToolManifest() {
  return tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

// The one entry point an LLM harness calls to invoke a tool. Returns a
// structured `{ ok, error?, kind?, hint? }` shape on failure so the
// harness can route the error back to the model. The hint is the
// diagnostic the original feedback asked for: when a tool is missing,
// the agent learns the right path forward instead of having to fish
// through source files.
export async function callTool(name, args = {}) {
  const tool = findTool(name);
  if (!tool) {
    const known = tools.map((t) => t.name).join(', ');
    return {
      ok: false,
      error: `unknown tool: ${name}`,
      kind: 'unknown_tool',
      hint:
        `The tool "${name}" is not registered. ` +
        `Call getToolManifest() (or list_tools) to see the available ` +
        `tools. Currently registered: ${known}.`,
    };
  }
  try {
    return await tool.execute(args);
  } catch (err) {
    return { ok: false, error: err.message, kind: 'execution_error' };
  }
}

export { subscribe };
