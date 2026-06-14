// MineAgent browser observer server.
//
// The observer is **embedded in the MCP server** (src/mcp-server.js) so
// the agent's process owns the bot state and the events. The MCP server
// calls startObserverServer() on startup, gated by the MA_OBSERVER_PORT
// env var (default 3000, set to 0 or empty to disable). The browser
// opens http://localhost:<port>/ and receives a live stream of every
// event the connection layer emits.
//
// In the previous architecture the observer was a separate process
// (`node server/index.js`) and a separate package.json script
// (`npm run observer`). That variant was broken: the observer's
// process never had the agent's bot, so the UI always showed the
// default disconnected state. The embedded variant is the only
// correct way to see live agent state. The standalone variant has
// been removed; the `npm run observer` script has been removed from
// package.json.
//
// The single in-world voice helper is say() in src/skills/chat.js.
// The /api/say HTTP route calls it so the browser "Send" button can
// forward a chat line into the in-game chat (and trigger the auto-TTS
// voice event the agent loop already broadcasts).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { getStatus } from '../src/connection.js';
import { say } from '../src/skills/chat.js';
import { subscribe } from '../src/events.js';
import { snapshot } from '../src/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDir = path.resolve(__dirname, '..', 'ui');
const defaultPort = Number(process.env.MA_OBSERVER_PORT || 3000);
const defaultHost = process.env.MA_OBSERVER_HOST || '127.0.0.1';

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 16384) {
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

export async function startObserverServer({
  port = defaultPort,
  host = defaultHost,
  publicDir = defaultPublicDir,
  logger = null,
  // All the in-process dependencies are passed in so the function is
  // testable and so a future process variant (e.g. a child-process
  // observer) can swap them out. Production callers leave them at the
  // defaults; the MCP server does too.
  getStatus: getStatusDep = getStatus,
  snapshot: snapshotDep = snapshot,
  subscribe: subscribeDep = subscribe,
  say: sayDep = say,
} = {}) {
  const log = (msg) => {
    if (typeof logger === 'function') logger(msg);
  };

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  function broadcast(event, payload) {
    const message = JSON.stringify({ event, payload, ts: Date.now() });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(message);
        } catch {
          // drop the client on a send failure; the close handler will clean up
        }
      }
    }
  }

  // Mirror every in-process event to every connected browser. The
  // listener is captured by closure so stop() can detach it.
  const off = subscribeDep((event, payload) => broadcast(event, payload));

  const server = http.createServer(async (req, res) => {
    if (req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getStatusDep()));
      return;
    }
    if (req.url === '/api/state') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(snapshotDep()));
      return;
    }
    if (req.url === '/api/say' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body.text !== 'string' || !body.text.trim()) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'text is required' }));
        return;
      }
      // sendChat auto-broadcasts a voice event for the browser observer
      // to play through TTS, so the chat endpoint no longer needs a
      // separate speak call. say() is the single in-world voice helper;
      // it converts a NotConnectedError throw into a structured envelope
      // so the HTTP route always gets a result, not a 500.
      const result = body.sendToGame !== false
        ? sayDep({ message: body.text })
        : { ok: true };
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ok: result.ok !== false,
          chat: result,
          voice: result.ok
            ? { ok: true, text: body.text }
            : { ok: false, error: result.error },
        })
      );
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      try {
        const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
        return;
      } catch (err) {
        res.statusCode = 500;
        res.end(`observer UI missing: ${err.message}`);
        return;
      }
    }
    if (req.url === '/app.js') {
      try {
        const js = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(js);
        return;
      } catch (err) {
        res.statusCode = 500;
        res.end(`/* observer app missing: ${err.message} */`);
        return;
      }
    }
    if (req.url === '/styles.css') {
      try {
        const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.end(css);
        return;
      } catch (err) {
        res.statusCode = 500;
        res.end(`/* observer styles missing: ${err.message} */`);
        return;
      }
    }
    res.statusCode = 404;
    res.end('Not found');
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    // Send an initial snapshot so the browser has data before the first event.
    try {
      ws.send(
        JSON.stringify({
          event: 'snapshot',
          payload: snapshotDep(),
          ts: Date.now(),
        })
      );
    } catch {
      // ignore
    }
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // Listen on an ephemeral port if the caller asked for 0. The
  // returned `port` reflects the actual bound port either way.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const bound = server.address();
  const actualPort = bound && typeof bound === 'object' ? bound.port : port;
  log(`[observer] http://${host}:${actualPort} (websocket at /ws)`);

  return {
    port: actualPort,
    host,
    stop: () =>
      new Promise((resolve) => {
        try {
          off();
        } catch {
          // ignore
        }
        // Close all websocket clients first so their handlers can run.
        for (const ws of clients) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
        clients.clear();
        wss.close(() => {
          server.close(() => resolve());
        });
      }),
  };
}
