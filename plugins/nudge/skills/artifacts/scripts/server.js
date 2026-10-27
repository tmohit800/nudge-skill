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
const repos = require('./repos');
const runbook = require('./runbook');

const DATA = c.dataDir();
const PORT = Number(process.env.NUDGE_SHELF_PORT || c.config().port) || 4783;
const SERVER_FILE = path.join(DATA, 'server.json');
const PAGE_FILE = path.join(DATA, 'shelf.html');
// plugin.json has no version on purpose, so installs follow the repo's commits. Each update lands in its own
// cache folder (…/plugins/cache/nudge/nudge/<commit>), so that folder tells one install from another.
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALL = path.basename(PLUGIN_ROOT);
const VERSION = c.readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), {}).version
  || (/^[0-9a-f]{7,}$/i.test(INSTALL) ? INSTALL.slice(0, 12) : 'local'); // a commit id, or "local" when run from a folder

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
    runbook: runbook.list(),
    reposNeedingAttention: repos.cachedAttention(), // null until the Repos tab has been opened once
  };
}

const allConversations = () => conversations.list({ automated: true, limit: Infinity }).conversations;

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
  if (method === 'GET' && url.pathname === '/api/trash') return sendJson(res, 200, { conversations: conversations.trash() });
  if (method === 'GET' && url.pathname === '/api/repos') {
    return sendJson(res, 200, await repos.board(allConversations(), c.config(), { refresh: url.searchParams.get('refresh') === '1' }));
  }
  if (method === 'GET' && url.pathname === '/api/runbook') return sendJson(res, 200, runbook.list());
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
  // /api/conversations/<id>/open { target: 'terminal' | 'vscode' }   /delete (to the trash)   /restore
  if (parts[1] === 'conversations' && parts[2] && parts[3] === 'open') {
    return sendJson(res, 200, conversations.open(parts[2], body.target === 'vscode' ? 'vscode' : 'terminal'));
  }
  if (parts[1] === 'conversations' && parts[2] && parts[3] === 'delete') return sendJson(res, 200, conversations.remove(parts[2]));
  if (parts[1] === 'conversations' && parts[2] && parts[3] === 'restore') return sendJson(res, 200, conversations.restore(parts[2]));
  if (url.pathname === '/api/trash/empty') return sendJson(res, 200, { deleted: conversations.emptyTrash() });
  // /api/conversations/<id>/meta { title?, pinned? }: your own name ('' brings back Claude Code's) and pin
  if (parts[1] === 'conversations' && parts[2] && parts[3] === 'meta') return sendJson(res, 200, conversations.setMeta(parts[2], body));

  // /api/repos/fetch { path }   /api/repos/open { path, target: 'vscode' | 'terminal' }
  if (url.pathname === '/api/repos/fetch' || url.pathname === '/api/repos/open') {
    const known = (await repos.board(allConversations(), c.config())).repos;
    if (parts[2] === 'fetch') return sendJson(res, 200, await repos.fetchRepo(String(body.path || ''), known));
    return sendJson(res, 200, repos.openFolder(String(body.path || ''), body.target, known));
  }

  // /api/runbook { title, command, notes, group } or { restore: item }   /api/runbook/<id> { patch }
  // /api/runbook/<id>/copied   /api/runbook/<id>/delete
  if (url.pathname === '/api/runbook') return sendJson(res, 201, runbook.add(body.restore || body));
  if (parts[1] === 'runbook' && parts[2] && !parts[3]) return sendJson(res, 200, runbook.update(parts[2], body));
  if (parts[1] === 'runbook' && parts[2] && parts[3] === 'copied') return sendJson(res, 200, runbook.copied(parts[2]));
  if (parts[1] === 'runbook' && parts[2] && parts[3] === 'delete') return sendJson(res, 200, runbook.remove(parts[2]));
  return send(res, 404, 'text/plain', 'Not found');
}

// Runs until the computer restarts or it's replaced by a newer install; every session start brings it back.
// The standalone app ("shelf.js start") has no publish hook, so it passes rescanEvery to pick up new work itself.
function serve({ onListening, rescanEvery } = {}) {
  const server = http.createServer((req, res) => {
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
    syncAll().catch(() => {}); // conversations aren't rescanned by the publish hook, so catch up on start
    if (rescanEvery) setInterval(() => syncAll().catch(() => {}), rescanEvery).unref();
    if (onListening) onListening(`http://127.0.0.1:${PORT}/`);
  });
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
