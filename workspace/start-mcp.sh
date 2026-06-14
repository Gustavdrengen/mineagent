#!/usr/bin/env bash
# Start the MineAgent MCP server.
#
# Usage: workspace/start-mcp.sh
#
# The MCP server is the single tool source for the MineAgent OpenCode
# agent (see .opencode/agents/mineagent.md) and for the test runner. It
# speaks line-delimited JSON-RPC 2.0 over stdio. OpenCode registers the
# server through opencode.json at the project root.
#
# The server itself enforces the "one instance at a time" rule on
# startup: when it boots, it reads the pidfile at
# $MINEAGENT_MCP_PIDFILE (default .runtime/mcp-server.pid), kills any
# process recorded there, and then writes its own PID. This makes it
# safe to re-run this script — the previous instance, if any, is shut
# down before the new one starts.
#
# This wrapper script exists so MCP config files can reference a stable
# path (workspace/start-mcp.sh) regardless of where the binary is run
# from, and so the project root is the working directory.

set -euo pipefail
cd "$(dirname "$0")/.."
exec node src/mcp-server.js
