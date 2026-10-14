// The shelf server: serves the Nudge Shelf page and its small JSON API on 127.0.0.1 only.
// Every request must be addressed to 127.0.0.1/localhost (blocks DNS-rebinding pages), and every change
// needs the X-Nudge header, which a page on another site can't send without a CORS preflight this server never approves.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const c = require('./common');
const artifacts = require('./artifacts');
const conversations = require('./conversations');

const DATA = c.dataDir();
const PORT = Number(process.env.NUDGE_SHELF_PORT || c.config().port) || 4783;
const IDLE_MS = 4 * 3600e3; // the server stops after 4 hours without a request
const SERVER_FILE = path.join(DATA, 'server.json');
const PAGE_FILE = path.join(DATA, 'shelf.html');
// plugin.json has no version on purpose, so installs follow the repo's commits. Each update lands in its own
// cache folder (…/plugins/cache/nudge/nudge/<commit>), so that folder tells one install from another.
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const VERSION = c.readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), {}).version || path.basename(PLUGIN_ROOT).slice(0, 12);

// ---------- the page ----------

function state() {
  const { full, generated, roots } = artifacts.cached();
  const conv = conversations.list({ limit: 0 });
  return {
    version: VERSION,
    generated,
    roots,
    port: PORT,
    artifacts: full,
    conversations: { total: conv.total, automated: conv.automated },
  };
}

function renderPage(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const tpl = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
  return tpl.replace('/*__SHELF_DATA__*/null', () => json);
}

// A static copy for when the server isn't running: artifacts only, read-only.
function writeStaticPage() {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${PAGE_FILE}.${process.pid}.tmp`;
  const { full, generated, roots } = artifacts.cached();
  fs.writeFileSync(tmp, renderPage({ version: VERSION, generated, roots, port: PORT, artifacts: full, static: true }));
  fs.renameSync(tmp, PAGE_FILE);
  return PAGE_FILE;
}

// ---------- helpers ----------

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
const sendJson = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 1e6) reject(Object.assign(new Error('Request too large'), { status: 413 }));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Bad JSON'), { status: 400 }));
      }
    });
  });
}

// The scans run in a child process so the server keeps answering while they work.
let syncing = null;
function syncAll() {
  syncing = syncing || new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, 'shelf.js'), 'sync'], { timeout: 300000, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim()));
  }).finally(() => (syncing = null));
  return syncing;
}

// ---------- routes ----------

async function route(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', renderPage(state()));
  }
  if (method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { app: 'nudge-shelf', pid: process.pid, port: PORT, version: VERSION, root: PLUGIN_ROOT });
  if (method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, state());
  if (method === 'GET' && url.pathname === '/api/conversations') {
    return sendJson(res, 200, conversations.list({
      q: url.searchParams.get('q') || '',
      project: url.searchParams.get('project') || '',
      automated: url.searchParams.get('automated') === '1',
    }));
  }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'conversations' && parts[2]) {
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
    return sendJson(res, 200, conversations.messages(parts[2], { before }));
  }

  if (method !== 'POST') return send(res, 404, 'text/plain', 'Not found');
  if (req.headers['x-nudge'] !== '1') return sendJson(res, 403, { error: 'Missing X-Nudge header' });
  const body = await readBody(req);

  if (url.pathname === '/api/sync') {
    const summary = await syncAll();
    return sendJson(res, 200, { ...state(), summary });
  }
  // /api/artifacts/<id>/labels { labels: [...] }   /api/artifacts/<id>/meta { pinned?, hidden? }
  if (parts[1] === 'artifacts' && parts[2] && parts[3] === 'labels') {
    if (!Array.isArray(body.labels)) return sendJson(res, 400, { error: 'labels must be a list' });
    artifacts.setLabels({ [parts[2]]: body.labels });
    writeStaticPage();
    return sendJson(res, 200, state());
  }
  if (parts[1] === 'artifacts' && parts[2] && parts[3] === 'meta') {
    artifacts.setMeta(parts[2], body);
    return sendJson(res, 200, state());
  }
  // /api/labels/rename { from, to } (to '' deletes the label everywhere)   /api/labels/restore { map }
  if (url.pathname === '/api/labels/rename') {
    const before = artifacts.renameLabel(String(body.from || ''), String(body.to || ''));
    writeStaticPage();
    return sendJson(res, 200, { ...state(), before });
  }
  if (url.pathname === '/api/labels/restore') {
    if (!body.map || typeof body.map !== 'object') return sendJson(res, 400, { error: 'map is required' });
    artifacts.setLabels(body.map);
    writeStaticPage();
    return sendJson(res, 200, state());
  }
  // /api/conversations/<id>/open { target: 'terminal' | 'vscode' }
  if (parts[1] === 'conversations' && parts[2] && parts[3] === 'open') {
    return sendJson(res, 200, conversations.open(parts[2], body.target === 'vscode' ? 'vscode' : 'terminal'));
  }
  return send(res, 404, 'text/plain', 'Not found');
}

function serve() {
  let lastHit = Date.now();
  const server = http.createServer((req, res) => {
    lastHit = Date.now();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) return send(res, 403, 'text/plain', 'Forbidden');
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return send(res, 403, 'text/plain', 'Forbidden');
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    route(req, res, url).catch((e) => sendJson(res, e.status || 500, { error: e.message }));
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    c.writeJson(SERVER_FILE, { pid: process.pid, port: PORT, version: VERSION, started: new Date().toISOString() });
    console.log(`Nudge Shelf at http://127.0.0.1:${PORT}/`);
  });
  setInterval(() => Date.now() - lastHit > IDLE_MS && process.exit(0), 60000).unref();
}

// Is a shelf server already answering on the port? Returns its version, or null.
function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j.app === 'nudge-shelf' ? j : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

module.exports = { serve, health, writeStaticPage, PORT, VERSION, PLUGIN_ROOT };
