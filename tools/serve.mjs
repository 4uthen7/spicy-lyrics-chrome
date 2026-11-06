#!/usr/bin/env node
/**
 * Static server for the demo harness.
 *
 * Routes:
 *   /                                  -> /demo/
 *   /demo/*                            -> files on disk
 *   /color-lyrics/v2/track/<id>        -> capture fixture for that mock track
 *   /assets/*, /src/*, /docs/*         -> files on disk (dev inspection only)
 *
 * The lyrics route exists because the real web player requests its lyrics from
 * a path containing /color-lyrics/, and the extension's main-world sniffer keys
 * off exactly that. Serving the fixture there exercises the same code path.
 *
 *   node tools/serve.mjs [--port 8787]
 * Programmatic: import { startServer } from './serve.mjs'
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Mock track id -> fixture file. Anything else is a 404 (like Spotify). */
const LYRICS_ROUTES = {
  '4cOdK2wGLETKBW3PvgPWqT': 'demo/fixtures/color-lyrics-word.json',
  '2Fxmhks0bxGSBdJ92vM42m': 'demo/fixtures/color-lyrics-line.json',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const full = join(root, clean);
  if (!full.startsWith(root + sep) && full !== root) return null;
  return full;
}

async function sendFile(req, res, filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  let pathname = url.pathname;

  if (pathname === '/') {
    res.writeHead(302, { Location: '/demo/' });
    return res.end();
  }

  // The real player requests /color-lyrics/v2/track/<id>/image/<encoded-url>.
  const lyricsMatch = pathname.match(/^\/color-lyrics\/v2\/track\/([A-Za-z0-9]+)(?:\/image\/.*)?$/);
  if (lyricsMatch) {
    const fixture = LYRICS_ROUTES[lyricsMatch[1]];
    if (!fixture) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const target = join(ROOT, fixture);
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'App-Platform': 'WebPlayer',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = safeJoin(ROOT, pathname);
  if (filePath && (await sendFile(req, res, filePath))) return;

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}

export function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 ' + (err && err.message));
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolvePromise({
        server,
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 8787;
  const handle = await startServer({ port });
  console.log(`demo harness: ${handle.url}/demo/`);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
