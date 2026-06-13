// MineAgent browser observer server.
//
// For the bootstrap, this is a tiny HTTP server that serves the static UI
// from public/ and exposes /status from the connection state machine. A
// later commit layers on WebSocket streaming for live updates.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStatus } from '../src/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'ui');
const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(getStatus()));
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
  res.statusCode = 404;
  res.end('Not found');
});

server.listen(port, () => {
  console.log(`[observer] http://localhost:${port}`);
});
