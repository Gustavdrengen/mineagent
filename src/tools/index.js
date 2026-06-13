// Tool registry for the vision-mandated connection tools.
//
// The five tools in VISION.md §"Connection Tools" are exposed here as a flat
// array the agent loop can iterate over. The shape is:
//
//   { name, description, parameters, execute(args) -> Promise<Result> }
//
// `parameters` is a lightweight schema used by future agent-loop layers to
// validate inputs and render help. The current bootstrap does not enforce it.

import {
  connectToServer,
  disconnectFromServer,
  sendChat,
  getStatus,
} from '../connection.js';
import { state, setStatus } from '../state.js';

const stringParam = (description) => ({ type: 'string', required: false, description });
const requiredStringParam = (description) => ({ type: 'string', required: true, description });

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
    parameters: {
      username: requiredStringParam('New default username.'),
    },
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
    execute: async () => {
      // The bootstrap returns a prompt the caller can present. A later commit
      // wires this into the interactive agent loop.
      return {
        ok: true,
        prompt: "Hey, what's the IP address? (or 'IP and port?')",
      };
    },
  },
];

export function findTool(name) {
  return tools.find((t) => t.name === name) || null;
}
