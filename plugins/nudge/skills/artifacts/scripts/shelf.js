#!/usr/bin/env node
// Nudge Shelf: every artifact and every conversation your Claude Code sessions have, on one searchable page.
// Reads session transcripts only; never calls claude.ai.
//
//   node shelf.js scan               rescan artifacts, print a summary (the default)
//   node shelf.js sync               rescan artifacts and conversations (what the page's Sync button runs)
//   node shelf.js unlabeled          JSON of artifacts that have no topic labels yet, plus labels in use
//   node shelf.js label <id> a,b     set the topic labels of one artifact (id or url; "" clears them)
//   node shelf.js label --from f     set labels from a JSON file: {"<id or url>": ["label", ...], ...}
//   node shelf.js find <words>       print the artifacts matching all the words
//   node shelf.js chats <words>      print the conversations matching all the words
//   node shelf.js open [words]       open the shelf (starts the local shelf server if needed)
//   node shelf.js start              the standalone app: run the shelf here, open it, rescan every minute (Ctrl+C stops)
//   node shelf.js serve              run the shelf server in the foreground (127.0.0.1 only)
//   node shelf.js ensure             start the shelf server in the background unless it's running (SessionStart hook)
//   node shelf.js hook               PostToolUse hook: record the publish/delete from stdin and rescan
//
// Options: --root <dir> adds a Claude config folder to scan (repeatable). NUDGE_ROOTS does the same,
// separated like PATH, and so does "roots" in <claude config dir>/nudge/config.json. By default it scans
// <home>/.claude, every <home>/.claude-* folder and CLAUDE_CONFIG_DIR.

const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const c = require('./common');
const artifacts = require('./artifacts');
const conversations = require('./conversations');
const server = require('./server');

function openInBrowser(target) {
  const url = /^https?:/.test(target) ? target : 'file:///' + target.replace(/\\/g, '/').replace(/^\/+/, '');
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]);
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  return url;
}

// Start the shelf server unless this install's server is already answering; replace one from another install.
async function ensureServer() {
  const running = await server.health();
  if (running && running.root === server.PLUGIN_ROOT) return true;
  if (running) {
    try {
      process.kill(running.pid);
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  spawn(process.execPath, [__filename, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await server.health()) return true;
  }
  return false;
}

function artifactRow(a) {
  const when = String(a.updated).slice(0, 10);
  const tags = [...a.labels, ...a.projects.map((p) => `@${p}`)].join(' ');
  return `${when}  ${a.title || '(untitled)'}${a.deleted ? '  [deleted]' : ''}\n            ${a.url}  v${a.versions}  ${tags}`;
}

function chatRow(m) {
  return `${String(m.updated).slice(0, 10)}  ${m.title}  @${m.project}${m.gitBranch ? ` (${m.gitBranch})` : ''}\n            ${m.id}  ${m.prompts} prompts${m.snippet ? `\n            ${m.snippet}` : ''}`;
}

const readStdin = () =>
  new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (d) => (raw += d));
    process.stdin.on('end', () => resolve(raw));
  });

function summarize(full) {
  const live = full.filter((a) => !a.deleted);
  return `Artifacts: ${live.length} live, ${full.length - live.length} deleted, ${live.filter((a) => !a.labels.length).length} without topic labels`;
}

async function main(argv) {
  const extraRoots = [];
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') extraRoots.push(argv[++i]);
    else args.push(argv[i]);
  }
  const [cmd = 'scan', ...rest] = args;

  switch (cmd) {
    case 'scan': {
      const { roots, files, read, full } = artifacts.scan(extraRoots);
      server.writeStaticPage();
      console.log(`Scanned ${files} transcripts (${read} new or changed) in: ${roots.join(', ') || '(no Claude config folders found)'}`);
      console.log(summarize(full));
      break;
    }
    case 'sync': {
      const { files, read, full } = artifacts.scan(extraRoots);
      const conv = conversations.sync();
      server.writeStaticPage();
      console.log(`Scanned ${files} transcripts (${read} new or changed). ${summarize(full)}. Conversations: ${conv.total} (${conv.read} updated)`);
      break;
    }
    case 'unlabeled': {
      const { full } = artifacts.scan(extraRoots);
      const inUse = {};
      for (const a of full) for (const l of a.labels) inUse[l] = (inUse[l] || 0) + 1;
      const todo = full
        .filter((a) => !a.deleted && !a.labels.length)
        .map(({ id, title, description, kind, projects, versionLabels }) => ({ id, title, description, kind, projects, versionLabels }));
      console.log(JSON.stringify({ labelsInUse: inUse, unlabeled: todo }, null, 2));
      break;
    }
    case 'label': {
      let map;
      if (rest[0] === '--from') map = c.readJson(path.resolve(rest[1]), null);
      else if (rest[0]) map = { [rest[0]]: rest.slice(1).join(',') };
      if (!map || typeof map !== 'object') throw new Error('Usage: label <id> a,b   or   label --from labels.json');
      const n = artifacts.setLabels(map);
      server.writeStaticPage();
      console.log(`Labelled ${n} artifact(s).`);
      break;
    }
    case 'find': {
      const hits = artifacts.search(artifacts.cached().full, rest);
      console.log(hits.length ? hits.map(artifactRow).join('\n') : `No artifacts match "${rest.join(' ')}".`);
      break;
    }
    case 'chats': {
      conversations.sync();
      const { conversations: hits, matches } = conversations.list({ q: rest.join(' '), limit: 25 });
      console.log(hits.length ? `${matches} match(es):\n${hits.map(chatRow).join('\n')}` : `No conversations match "${rest.join(' ')}".`);
      break;
    }
    case 'open': {
      artifacts.scan(extraRoots);
      server.writeStaticPage();
      const query = rest.join(' ');
      if (await ensureServer()) {
        console.log(`Opened ${openInBrowser(`http://127.0.0.1:${server.PORT}/${query ? `?q=${encodeURIComponent(query)}` : ''}`)}`);
      } else {
        console.log(`The shelf server didn't start (is port ${server.PORT} taken? set "port" in ${path.join(c.dataDir(), 'config.json')}).`);
        console.log(`Opened the read-only copy instead: ${openInBrowser(path.join(c.dataDir(), 'shelf.html'))}`);
      }
      break;
    }
    case 'start': {
      const running = await server.health();
      if (running) {
        console.log(`The shelf is already running. Opened ${openInBrowser(`http://127.0.0.1:${server.PORT}/`)}`);
        break;
      }
      server.serve({
        rescanEvery: 60e3,
        onListening: (url) => {
          openInBrowser(url);
          console.log('Opened it in your browser. Keep this window open while you use it; Ctrl+C stops it.');
        },
      });
      break;
    }
    case 'serve':
      server.serve();
      break;
    case 'ensure': // SessionStart hook: keep the shelf server running, quietly
      if (c.config().autostart !== false) await ensureServer().catch(() => {});
      break;
    case 'hook':
      try {
        if (artifacts.recordHookEvent(JSON.parse(await readStdin()))) server.writeStaticPage();
      } catch {
        // a hook must never get in the way of the session
      }
      break;
    default:
      throw new Error(`Unknown command "${cmd}". Use start, scan, sync, unlabeled, label, find, chats, open or serve.`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e.message);
  process.exit(process.argv[2] === 'hook' ? 0 : 1);
});
