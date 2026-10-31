// Runs the whole site on any host with Node.js 18+. No npm install needed.
//   node server.mjs      PORT and DATA_DIR environment variables are optional
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './lib/core.mjs';
import { fileStore } from './lib/store-file.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 2 * 1024 * 1024;

const api = createApi(fileStore(process.env.DATA_DIR || path.join(ROOT, 'data')));

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveApi(req, res) {
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, SECURITY_HEADERS).end();
      return;
    }
  }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const response = await api(
    new Request(`${proto}://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body }),
  );
  res.writeHead(response.status, { ...SECURITY_HEADERS, ...Object.fromEntries(response.headers) });
  res.end(await response.text());
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS).end();
    return;
  }
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' }).end('Not found');
  }
}

createServer((req, res) => {
  const handler = req.url.startsWith('/api/') ? serveApi : serveStatic;
  handler(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(PORT, () => console.log(`PMA Attendance running at http://localhost:${PORT}`));
