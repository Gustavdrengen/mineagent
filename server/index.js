// MineAgent browser observer server.
//
// Serves the static UI, exposes /status and /api/state for plain HTTP
// consumers, and runs a WebSocket server at the same port that broadcasts
// every event from the in-process emitter as a JSON message. The agent
// loop and the connection layer use the same emitter.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { getStatus } from '../src/connection.js';
import { subscribe } from '../src/events.js';
import { snapshot } from '../src/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'ui');
const port = Number(process.env.PORT || 3000);

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

// Mirror every in-process event to every connected browser.
subscribe((event, payload) => broadcast(event, payload));

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

const server = http.createServer(async (req, res) => {
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(getStatus()));
    return;
  }
  if (req.url === '/api/state') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(snapshot()));
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
    const { sendChat } = await import('../src/connection.js');
    const { speak } = await import('../src/speak.js');
    const chatResult = body.sendToGame !== false
      ? sendChat(body.text)
      : { ok: true };
    const voiceResult = speak(body.text);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, chat: chatResult, voice: voiceResult }));
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
      JSON.stringify({ event: 'snapshot', payload: snapshot(), ts: Date.now() })
    );
  } catch {
    // ignore
  }
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(port, () => {
  console.log(`[observer] http://localhost:${port}`);
  console.log(`[observer] websocket: ws://localhost:${port}/ws`);
});
