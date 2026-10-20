/**
 * Production Standalone HTTP & RFC 6455 WebSocket Server
 * Serves static web client assets (index.html, JS, CSS) and handles real-time relay connections.
 * 
 * Zero external dependencies (uses standard Node.js built-in modules).
 * Suitable for instant hosting on Render, Fly.io, Railway, Heroku, or VPS.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelayServer } from './src/relay.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// MIME types for static asset serving
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm'
};

// Root HTTP server for static files
const server = http.createServer((req, res) => {
  // Health check endpoint for cloud platforms
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime() }));
    return;
  }

  // Parse path safely
  let safePath = req.url.split('?')[0];
  if (safePath === '/' || safePath === '') {
    safePath = '/index.html';
  }

  // Prevent directory traversal attacks
  const normalizedPath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, normalizedPath);

  // Verify the target path stays within project root
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA Fallback: serve index.html for unknown routes without extension
      if (!path.extname(normalizedPath)) {
        const indexPath = path.join(__dirname, 'index.html');
        fs.readFile(indexPath, (indexErr, content) => {
          if (indexErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

// Attach the Authoritative Relay Server to the existing HTTP server
const relay = createRelayServer({ server });

relay.listen(PORT, HOST, () => {
  console.log(`========================================================`);
  console.log(`🚀 RPM Modern Tabletop Arena Server Running!`);
  console.log(`📡 Local URL:       http://localhost:${PORT}`);
  console.log(`⚡ WebSocket Relay: ws://localhost:${PORT}`);
  console.log(`🌍 Bound to:        ${HOST}:${PORT}`);
  console.log(`========================================================`);
});

// Handle graceful termination
process.on('SIGINT', () => {
  console.log('\nGracefully shutting down...');
  relay.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\nGracefully terminating...');
  relay.close(() => {
    process.exit(0);
  });
});

export { server, relay };
