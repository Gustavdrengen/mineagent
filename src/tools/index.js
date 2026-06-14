// Tool registry for MineAgent.
//
// Every tool in MineAgent is described in a single shape:
//
//   {
//     name:        string,        // unique identifier
//     description: string,        // natural-language description for the LLM
//     parameters:  JSON Schema object  // strict subset: { type, properties, required, additionalProperties }
//     execute:     async (args) => { ok, ... }
//   }
//
// The registry's internal field name is `parameters`. The MCP wire
// format (the only consumer) names the same field `inputSchema`; the
// MCP server in `src/mcp-server.js` does the rename on the way out.
// OpenCode prefixes every tool with the server name (`mineagent_*`),
// so the agent sees e.g. `mineagent_connect_to_server` in its tool
// palette.

import {
  connectToServer,
  disconnectFromServer,
  getStatus,
} from '../connection.js';
import { state } from '../state.js';
import { say, waitForChat } from '../skills/chat.js';
import { shutdown, writeSessionSummary, commitImprovements } from '../shutdown.js';
import {
  createSkill,
  updateSkill,
  removeSkill,
  createScript,
  writeMemory,
  readLastServer,
  clearLastServer,
  listSkills,
  listScripts,
  listMemories,
  readSkill,
  readScript,
  readMemory,
  proposeSkillChange,
  listProposals,
  readProposal,
  rejectProposal,
} from '../improve.js';
import { subscribe } from '../events.js';
import {
  moveToCoordinates,
  stopMoving,
  followPlayer,
} from '../skills/movement.js';
import {
  mineBlock,
  placeBlock,
  lookAtBlock,
} from '../skills/world-interaction.js';
import {
  equipItem,
  dropItem,
  useHeldItem,
  readChatHistory,
  scanNearbyEntities,
  getBlockInfo,
  findBlock,
  lookAtPosition,
  attackEntity,
} from '../skills/in-world.js';

export const PARAM = {
  string: (description, { required = false, enum: enumValues } = {}) => {
    const out = { type: 'string', description };
    if (enumValues) out.enum = enumValues;
    if (required) out._required = true;
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

export const tools = [
  {
    name: 'connect_to_server',
    description:
      'Start a Mineflayer connection given a host, port, and username. ' +
      'Reports success or a structured error with a stable error.kind ' +
      '(unreachable, refused, timeout, auth_required, version_mismatch, ' +
      'not_whitelisted, kicked, no_host, already_connecting, unknown). ' +
      'MineAgent only connects to offline-mode servers.',
    parameters: buildParameters({
      host: PARAM.string('Server hostname or IP address.', { required: true }),
      port: PARAM.number('Server port. Defaults to 25565.'),
      username: PARAM.string('In-game username. Defaults to the configured username (MineAgent).'),
    }),
    execute: async ({ host, port, username } = {}) => connectToServer({ host, port, username }),
  },
  {
    name: 'disconnect_from_server',
    description: 'Clean shutdown of the current Mineflayer connection.',
    parameters: buildParameters({}),
    execute: async () => disconnectFromServer(),
  },
  {
    name: 'set_username',
    description: 'Override the username used for the next connect.',
    parameters: buildParameters({
      username: PARAM.string('New default username.', { required: true }),
    }),
    execute: async ({ username } = {}) => {
      if (!username) return { ok: false, error: 'username is required' };
      state.config.username = username;
      return { ok: true, username: state.config.username };
    },
  },
  {
    name: 'connection_status',
    description: 'Live snapshot of the bot state.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, ...getStatus() }),
  },
  {
    name: 'send_chat',
    description:
      'Send a line of text in chat. Auto-plays through the browser ' +
      'observer TTS as an internal side effect. The agent never calls ' +
      'a separate TTS tool.',
    parameters: buildParameters({
      text: PARAM.string('Chat line to send.', { required: true }),
    }),
    execute: async ({ text } = {}) => {
      // say() in src/skills/chat.js is the single in-world voice helper
      // and the single NotConnectedError-to-envelope conversion point.
      // It also owns the input validation. The wire format on success
      // is the say() envelope: { ok, message: text }.
      return say({ message: text });
    },
  },
  {
    name: 'wait_for_chat',
    description:
      "**The persona's idle tick. Call this whenever you have nothing " +
      "else to do — and do not end your turn on player silence.** " +
      "Blocks until the next in-world chat message arrives from a " +
      "player, or until `timeoutMs` has elapsed (default 10000, " +
      "clamped to [100, 60000]). On `ok: false, timeout: true`, this " +
      "is the normal idle signal — call `wait_for_chat` again. This " +
      "is not an error. Returns { ok: true, from, message, ts } on a " +
      "chat message, { ok: false, timeout: true, error, waitedMs } on " +
      "timeout, or { ok: false, error, kind: 'not_connected' } when " +
      "the bot is offline. The persona must not consider its turn " +
      "finished until the player tells it to leave the server.",
    parameters: buildParameters({
      timeoutMs: PARAM.number(
        'How long to wait in milliseconds. Default 10000. ' +
          'Clamped to [100, 60000].'
      ),
    }),
    execute: async ({ timeoutMs } = {}) => waitForChat({ timeoutMs }),
  },
  {
    name: 'ask_user_for_server',
    description: 'Return a prompt the calling layer can present to the user.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, prompt: "Hey, what's the IP address? (or 'IP and port?')" }),
  },
  {
    name: 'connect_to_last_known_server',
    description: 'Reconnect to the server in memories/last-server.json.',
    parameters: buildParameters({}),
    execute: async () => {
      const remembered = readLastServer();
      if (!remembered || !remembered.host) {
        return { ok: false, error: 'no remembered server in memories/', kind: 'no_memory' };
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
    description: 'Clear the remembered server in workspace/memories/last-server.json.',
    parameters: buildParameters({}),
    execute: async () => {
      clearLastServer();
      return { ok: true, forgotten: true };
    },
  },

  // --- In-world action tools (T1) -----------------------------------------
  {
    name: 'move_to',
    description:
      'Walk the bot to a destination via pathfinding. If the destination ' +
      'is occupied by a solid block (a tree, a wall, an ore), the bot ' +
      'stops adjacent to it within `tolerance` blocks (default 1) instead ' +
      'of trying to walk into the obstacle. Times out after `timeoutMs` ' +
      'milliseconds (default 30000; pass 0 to disable). Returns ' +
      '{ ok: true, arrivedAt } on success, or { ok: false, kind } with one ' +
      'of `no_path`, `destination_blocked` (pathfinder reached a partial ' +
      'path and gave up, e.g. the destination is surrounded by walls), ' +
      `timeout, not_connected, coords_invalid, timeout_invalid, no_pathfinder, path_error, kicked on failure. The persona should not call move_to on a coordinate that is inside a solid block expecting the bot to stand there — pick a coordinate on a walkable surface or an adjacent position.`,
    parameters: buildParameters({
      x: PARAM.number('Destination X coordinate.', { required: true }),
      y: PARAM.number('Destination Y coordinate.', { required: true }),
      z: PARAM.number('Destination Z coordinate.', { required: true }),
      tolerance: PARAM.number('How close counts as "arrived" in blocks. Defaults to 1. Used as the GoalNear radius when the destination is a solid block.'),
      timeoutMs: PARAM.number('Maximum time to wait for arrival in milliseconds. Default 30000. Pass 0 to disable the timeout.'),
    }),
    execute: async ({ x, y, z, tolerance, timeoutMs } = {}) => moveToCoordinates({ x, y, z, tolerance, timeoutMs }),
  },
  {
    name: 'stop_moving',
    description: 'Stop the current movement and any active follow loop.',
    parameters: buildParameters({}),
    execute: async () => stopMoving(),
  },
  {
    name: 'follow_player',
    description: 'Follow a player by name for up to durationMs (default 30s).',
    parameters: buildParameters({
      username: PARAM.string('Player username to follow.', { required: true }),
      durationMs: PARAM.number('Maximum follow duration in milliseconds. Default 30000.'),
    }),
    execute: async ({ username, durationMs } = {}) => followPlayer({ username, durationMs }),
  },
  {
    name: 'look_at_block',
    description: 'Look at the block at a coordinate. Returns the block name.',
    parameters: buildParameters({
      x: PARAM.number('Block X coordinate.', { required: true }),
      y: PARAM.number('Block Y coordinate.', { required: true }),
      z: PARAM.number('Block Z coordinate.', { required: true }),
    }),
    execute: async ({ x, y, z } = {}) => lookAtBlock({ position: { x, y, z } }),
  },
  {
    name: 'look_at_position',
    description: 'Look at an arbitrary point in the world.',
    parameters: buildParameters({
      x: PARAM.number('X coordinate.', { required: true }),
      y: PARAM.number('Y coordinate.', { required: true }),
      z: PARAM.number('Z coordinate.', { required: true }),
    }),
    execute: async ({ x, y, z } = {}) => lookAtPosition({ x, y, z }),
  },
  {
    name: 'mine_block',
    description:
      'Mine a block by name. Searches within `range` blocks (default 4) ' +
      'and only digs blocks the bot can actually reach (within 4.5 blocks ' +
      'of its position) and can actually dig (not bedrock, etc.). ' +
      'Out-of-reach and undiggable candidates are silently skipped — the ' +
      'tool finds the next-nearest one rather than failing the whole ' +
      'request. The bot looks at the target before swinging so the dig ' +
      'animation lands on the right block. Returns ' +
      '{ ok: true, blocksTouched } on success, or { ok: false, kind } with ' +
      'one of `out_of_reach` (no candidate within reach; the response ' +
      'includes the position of the nearest one so the persona can call ' +
      'move_to first), `not_diggable` (no candidate can be broken; bedrock, ' +
      'water, etc.), `no_block_in_range` (none in `range` at all), ' +
      '`dig_failed` (Mineflayer error; `error` carries the message), ' +
      '`not_connected`, `name_required`, `count_invalid`, `unknown_block`, ' +
      '`no_position` on failure.',
    parameters: buildParameters({
      name: PARAM.string('Block name to mine (e.g. "oak_log", "dirt").', { required: true }),
      count: PARAM.number('How many blocks to mine. Default 1.'),
      range: PARAM.number('Search radius in blocks. Default 4. The tool may use a smaller effective search if all blocks in `range` are out of reach.'),
    }),
    execute: async ({ name, count, range } = {}) => mineBlock({ name, count, range }),
  },
  {
    name: 'place_block',
    description: 'Place a block from the bot\'s inventory at a coordinate.',
    parameters: buildParameters({
      name: PARAM.string('Block name to place (must be in inventory).', { required: true }),
      x: PARAM.number('Target X coordinate.', { required: true }),
      y: PARAM.number('Target Y coordinate.', { required: true }),
      z: PARAM.number('Target Z coordinate.', { required: true }),
    }),
    execute: async ({ name, x, y, z } = {}) => placeBlock({ name, position: { x, y, z } }),
  },
  {
    name: 'find_block',
    description: 'Find the nearest block of a given name within maxDistance blocks (default 16).',
    parameters: buildParameters({
      name: PARAM.string('Block name to search for.', { required: true }),
      maxDistance: PARAM.number('Search radius in blocks. Default 16.'),
    }),
    execute: async ({ name, maxDistance } = {}) => findBlock({ name, maxDistance }),
  },
  {
    name: 'read_chat_history',
    description: 'Read the last `limit` chat messages (default 20, max 100).',
    parameters: buildParameters({
      limit: PARAM.number('How many of the most recent messages to return. Default 20.'),
    }),
    execute: async ({ limit } = {}) => readChatHistory({ limit }),
  },
  {
    name: 'scan_nearby_entities',
    description: 'List nearby entities, optionally filtered by type.',
    parameters: buildParameters({
      maxDistance: PARAM.number('Search radius in blocks. Default 32.'),
      type: PARAM.string('Entity type filter.', {
        enum: ['all', 'player', 'mob', 'other', 'hostile', 'passive'],
      }),
    }),
    execute: async ({ maxDistance, type } = {}) => scanNearbyEntities({ maxDistance, type }),
  },
  {
    name: 'get_block_info',
    description: 'Get the block at a coordinate. Returns the block name, type, and metadata.',
    parameters: buildParameters({
      x: PARAM.number('Block X coordinate.', { required: true }),
      y: PARAM.number('Block Y coordinate.', { required: true }),
      z: PARAM.number('Block Z coordinate.', { required: true }),
    }),
    execute: async ({ x, y, z } = {}) => getBlockInfo({ x, y, z }),
  },
  {
    name: 'equip_item',
    description: 'Equip an item from the bot\'s inventory by name.',
    parameters: buildParameters({
      name: PARAM.string('Item name to equip (e.g. "iron_pickaxe").', { required: true }),
      destination: PARAM.string('Where to equip the item.', {
        enum: ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'],
      }),
    }),
    execute: async ({ name, destination } = {}) => equipItem({ name, destination }),
  },
  {
    name: 'drop_item',
    description: 'Drop an item from the bot\'s inventory. `count` defaults to 1.',
    parameters: buildParameters({
      name: PARAM.string('Item name to drop.', { required: true }),
      count: PARAM.number('How many to drop. Default 1.'),
    }),
    execute: async ({ name, count } = {}) => dropItem({ name, count }),
  },
  {
    name: 'use_held_item',
    description: 'Use the held item (right-click).',
    parameters: buildParameters({}),
    execute: async () => useHeldItem(),
  },
  {
    name: 'attack_entity',
    description: 'Attack an entity by username (player) or entityId (any entity).',
    parameters: buildParameters({
      username: PARAM.string('Player username to attack.'),
      entityId: PARAM.number('Entity id to attack (from scan_nearby_entities).'),
    }),
    execute: async ({ username, entityId } = {}) => attackEntity({ username, entityId }),
  },

  {
    name: 'shutdown',
    description: 'Stop the bot, write a session summary into memories/, and attempt a commit.',
    parameters: buildParameters({
      exitReason: PARAM.string('Why the bot is shutting down.'),
    }),
    execute: async ({ exitReason } = {}) => shutdown({ exitReason }),
  },
  {
    name: 'create_skill',
    description: 'Write a new file into workspace/skills/. Committed modification; requires propose_skill_change + user approval first.',
    parameters: buildParameters({
      name: PARAM.string('Alphanumeric name for the skill (a-z 0-9 _ -).', { required: true }),
      body: PARAM.string('File body to write.', { required: true }),
      kind: PARAM.string('"doc" (default) or "code".', { enum: ['doc', 'code'] }),
    }),
    execute: async ({ name, body, kind } = {}) => createSkill({ name, body, kind }),
  },
  {
    name: 'update_skill',
    description: 'Replace the body of an existing skill in workspace/skills/. Committed modification; requires propose_skill_change + user approval first.',
    parameters: buildParameters({
      name: PARAM.string('Alphanumeric name of the skill to update.', { required: true }),
      body: PARAM.string('New file body to write.', { required: true }),
      kind: PARAM.string('"doc" (default) or "code".', { enum: ['doc', 'code'] }),
    }),
    execute: async ({ name, body, kind } = {}) => updateSkill({ name, body, kind }),
  },
  {
    name: 'remove_skill',
    description: 'Delete a skill from workspace/skills/. Committed modification; requires propose_skill_change + user approval first.',
    parameters: buildParameters({
      name: PARAM.string('Alphanumeric name of the skill to remove.', { required: true }),
      kind: PARAM.string('"doc" (default) or "code".', { enum: ['doc', 'code'] }),
    }),
    execute: async ({ name, kind } = {}) => removeSkill({ name, kind }),
  },
  {
    name: 'propose_skill_change',
    description: 'Write a proposal to memories/proposals/ and return a chat-prompt for the user.',
    parameters: buildParameters({
      name: PARAM.string('Alphanumeric skill name (a-z 0-9 _ -).', { required: true }),
      action: PARAM.string('The kind of change.', { required: true, enum: ['create', 'revise', 'remove', 'generalize'] }),
      body: PARAM.string('Proposed body. Required for create/revise/generalize; ignored for remove.'),
      kind: PARAM.string('"doc" (default) or "code".', { enum: ['doc', 'code'] }),
      summary: PARAM.string('One-sentence description.', { required: true }),
      reason: PARAM.string('The learning opportunity.', { required: true }),
    }),
    execute: async ({ name, action, body, kind, summary, reason } = {}) =>
      proposeSkillChange({ name, action, body, kind, summary, reason }),
  },
  {
    name: 'list_proposals',
    description: 'List pending skill-change proposals.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, proposals: listProposals() }),
  },
  {
    name: 'read_proposal',
    description: 'Read a proposal by its proposalId.',
    parameters: buildParameters({
      proposalId: PARAM.string('Proposal id (filename without .md).', { required: true }),
    }),
    execute: async ({ proposalId } = {}) => readProposal(proposalId),
  },
  {
    name: 'reject_proposal',
    description: 'Delete a pending proposal.',
    parameters: buildParameters({
      proposalId: PARAM.string('Proposal id (filename without .md).', { required: true }),
    }),
    execute: async ({ proposalId } = {}) => rejectProposal(proposalId),
  },
  {
    name: 'create_script',
    description: 'Write a reusable helper into workspace/scripts/. Committed modification; requires propose_skill_change + user approval first.',
    parameters: buildParameters({
      name: PARAM.string('Alphanumeric name (a-z 0-9 _ -).', { required: true }),
      body: PARAM.string('File body to write.', { required: true }),
    }),
    execute: async ({ name, body } = {}) => createScript({ name, body }),
  },
  {
    name: 'write_memory',
    description: 'Write a note into workspace/memories/ (gitignored).',
    parameters: buildParameters({
      name: PARAM.string('Alphanumeric name.', { required: true }),
      body: PARAM.string('File body to write.', { required: true }),
    }),
    execute: async ({ name, body } = {}) => writeMemory({ name, body }),
  },
  {
    name: 'list_skills',
    description: 'List files in workspace/skills/.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, skills: listSkills() }),
  },
  {
    name: 'list_scripts',
    description: 'List files in workspace/scripts/.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, scripts: listScripts() }),
  },
  {
    name: 'list_memories',
    description: 'List files in workspace/memories/.',
    parameters: buildParameters({}),
    execute: async () => ({ ok: true, memories: listMemories() }),
  },
  {
    name: 'read_skill',
    description: 'Read the body of a skill.',
    parameters: buildParameters({
      name: PARAM.string('Skill name (no extension).', { required: true }),
      kind: PARAM.string('"doc" (default) or "code".', { enum: ['doc', 'code'] }),
    }),
    execute: async ({ name, kind } = {}) => readSkill({ name, kind }),
  },
  {
    name: 'read_script',
    description: 'Read the body of a script.',
    parameters: buildParameters({
      name: PARAM.string('Script name (no extension).', { required: true }),
    }),
    execute: async ({ name } = {}) => readScript({ name }),
  },
  {
    name: 'read_memory',
    description: 'Read a memory file (full filename including extension).',
    parameters: buildParameters({
      name: PARAM.string('Memory filename including extension.', { required: true }),
    }),
    execute: async ({ name } = {}) => readMemory({ name }),
  },
];

export function findTool(name) {
  return tools.find((t) => t.name === name) || null;
}

export function findToolsByPrefix(prefix) {
  return tools.filter((t) => t.name.startsWith(prefix));
}

export function getToolManifest() {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function callTool(name, args = {}) {
  const tool = findTool(name);
  if (!tool) {
    const known = tools.map((t) => t.name).join(', ');
    return {
      ok: false,
      error: `unknown tool: ${name}`,
      kind: 'unknown_tool',
      hint: `The tool "${name}" is not registered. Call getToolManifest() (or list_tools) to see the available tools. Currently registered: ${known}.`,
    };
  }
  try {
    return await tool.execute(args);
  } catch (err) {
    return { ok: false, error: err.message, kind: 'execution_error' };
  }
}

export { subscribe };
