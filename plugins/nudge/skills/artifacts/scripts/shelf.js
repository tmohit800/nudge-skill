#!/usr/bin/env node
// Nudge artifact shelf: finds every artifact your Claude Code sessions published, keeps their labels,
// and writes a searchable, themed page listing them. Reads session transcripts only; never calls claude.ai.
//
//   node shelf.js scan               rescan, rebuild the shelf page, print a summary (the default)
//   node shelf.js unlabeled          JSON of artifacts that have no topic labels yet, plus labels in use
//   node shelf.js label <id> a,b     set the topic labels of one artifact (id or url; "" clears them)
//   node shelf.js label --from f     set labels from a JSON file: {"<id or url>": ["label", ...], ...}
//   node shelf.js find <words>       print the artifacts matching all the words
//   node shelf.js open [words]       rebuild and open the shelf in the browser, optionally pre-searched
//
// Options: --root <dir> adds a Claude config folder to scan (repeatable). NUDGE_ROOTS does the same,
// separated like PATH. By default it scans <home>/.claude, every <home>/.claude-* folder and CLAUDE_CONFIG_DIR.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const c = require('./common');

const DATA = c.dataDir();
const FILES = {
  list: path.join(DATA, 'artifacts.json'),
  labels: path.join(DATA, 'labels.json'),
  page: path.join(DATA, 'shelf.html'),
  searchPage: path.join(DATA, 'shelf-search.html'), // a pre-searched copy; Windows drops #q= from file links
};

// ---------- finding the config folders ----------

function configRoots(extra) {
  const roots = new Set([c.configDir()]);
  const home = os.homedir();
  try {
    for (const name of fs.readdirSync(home)) {
      if (/^\.claude([-_.].+)?$/.test(name)) roots.add(path.join(home, name));
    }
  } catch {}
  for (const r of (process.env.NUDGE_ROOTS || '').split(path.delimiter)) if (r) roots.add(path.resolve(r));
  for (const r of extra) roots.add(path.resolve(r));
  return [...roots].filter((r) => fs.existsSync(path.join(r, 'projects')));
}

function* transcripts(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* transcripts(full);
    else if (e.name.endsWith('.jsonl')) yield full;
  }
}

// ---------- reading the transcripts ----------

// One event per artifact tool call that succeeded: {id, ts, sid, cwd, tool, input, result, text}.
function readEvents(file, seen) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (!text.includes('claude.ai/')) return [];

  const calls = new Map(); // tool_use id -> call, waiting for its result
  const events = [];
  const launch = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text); // the folder the session was started in
  const launchDir = launch ? JSON.parse(`"${launch[1]}"`) : '';
  for (const line of text.split('\n')) {
    const isUse = line.includes('"tool_use"') && (line.includes('"name":"Artifact"') || line.includes('Claude_Docs__'));
    const isResult = calls.size && line.includes('"tool_result"');
    if (!isUse && !isResult) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
    for (const b of blocks) {
      if (b.type === 'tool_use' && c.artifactAction(b.name, b.input)) {
        calls.set(b.id, { tool: b.name, input: b.input || {}, ts: o.timestamp, sid: o.sessionId, cwd: o.cwd, launchDir });
      } else if (b.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const call = calls.get(b.tool_use_id);
        calls.delete(b.tool_use_id);
        if (b.is_error || seen.has(b.tool_use_id)) continue; // resumed or forked sessions repeat history
        seen.add(b.tool_use_id);
        events.push({ ...call, id: b.tool_use_id, ts: o.timestamp || call.ts, result: o.toolUseResult, text: c.asText(b.content) });
      }
    }
  }
  return events;
}

// The project is the top folder under the session's launch folder that the call ran in
// (d:\work + d:\work\api\src -> "api"), or the launch folder itself.
function projectName(cwd, launchDir) {
  const parts = (p) => (p || '').split(/[\\/]/).filter(Boolean);
  const [here, base] = [parts(cwd), parts(launchDir)];
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const inside = base.length && here.length > base.length && base.every((p, i) => same(p, here[i]));
  if (inside) return here[base.length];
  return (base.length ? base : here).pop() || '';
}

function kindOf(ev) {
  if (c.isDocTool(ev.tool)) return 'Doc';
  if (ev.input.type_url) return 'Typed';
  if (/\.md$/i.test(ev.input.file_path || '')) return 'Markdown';
  return 'Page';
}

function buildList(events) {
  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const byId = new Map();
  for (const ev of events) {
    const action = c.artifactAction(ev.tool, ev.input);
    const r = ev.result && typeof ev.result === 'object' ? ev.result : {};
    const url = action === 'delete' ? ev.input.url : r.url || c.URL_RE.exec(ev.text)?.[0] || ev.input.url;
    const id = c.URL_RE.exec(url || '')?.[1];
    if (!id) continue;

    let a = byId.get(id);
    if (!a) {
      if (action === 'delete') continue; // deleted before we ever saw it published
      a = {
        id,
        url: url.replace(/[).,;]+$/, ''),
        title: '',
        description: '',
        icon: '',
        kind: kindOf(ev),
        created: ev.ts,
        updated: ev.ts,
        versions: 0,
        versionLabels: [],
        projects: [],
        cwds: [],
        sessions: [],
        files: [],
        deleted: false,
      };
      byId.set(id, a);
    }
    if (action === 'delete') {
      a.deleted = true;
      a.updated = ev.ts;
      continue;
    }
    a.deleted = false;
    a.updated = ev.ts;
    a.versions += 1;
    const file = ev.input.file_path || '';
    a.title = r.title || ev.input.title || ev.input.container?.create?.name || c.titleFromFile(file) || a.title ||
      (file ? path.basename(file).replace(/\.\w+$/, '') : '');
    a.description = ev.input.description || a.description;
    a.icon = r.icon || ev.input.icon || a.icon;
    if (ev.input.label) a.versionLabels.push(ev.input.label);
    const add = (list, v) => v && !list.includes(v) && list.push(v);
    add(a.projects, projectName(ev.cwd, ev.launchDir));
    add(a.cwds, ev.cwd);
    add(a.sessions, ev.sid);
    add(a.files, file);
  }
  return [...byId.values()].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

// ---------- labels ----------

const loadLabels = () => c.readJson(FILES.labels, {});
const idOf = (s) => c.URL_RE.exec(s)?.[1] || s.trim();
const cleanLabels = (ls) => [...new Set((ls || []).map((l) => String(l).trim().toLowerCase()).filter(Boolean))];

function setLabels(map) {
  const labels = loadLabels();
  for (const [key, ls] of Object.entries(map)) {
    const id = idOf(key);
    const clean = cleanLabels(Array.isArray(ls) ? ls : String(ls).split(','));
    if (clean.length) labels[id] = clean;
    else delete labels[id];
  }
  c.writeJson(FILES.labels, labels);
  return Object.keys(map).length;
}

function withLabels(list) {
  const labels = loadLabels();
  return list.map((a) => ({ ...a, labels: labels[a.id] || [] }));
}

// ---------- search ----------

const haystack = (a) =>
  [a.title, a.description, a.url, a.kind, ...a.labels, ...a.projects, ...a.versionLabels].join(' ').toLowerCase();

function search(list, words) {
  const terms = words.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((a) => terms.every((t) => haystack(a).includes(t)));
}

// ---------- the shelf page ----------

function buildPage(list, { file = FILES.page, query = '' } = {}) {
  const data = JSON.stringify({ generated: new Date().toISOString(), query, artifacts: list }).replace(/</g, '\\u003c');
  const tpl = fs.readFileSync(path.join(__dirname, 'shelf-template.html'), 'utf8');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, tpl.replace('/*__SHELF_DATA__*/null', () => data));
  return file;
}

function openInBrowser(file) {
  const url = 'file:///' + file.replace(/\\/g, '/').replace(/^\/+/, '');
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]);
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  return url;
}

// ---------- commands ----------

function scan(extraRoots) {
  const roots = configRoots(extraRoots);
  const seen = new Set();
  let files = 0;
  const events = [];
  for (const root of roots) {
    for (const f of transcripts(path.join(root, 'projects'))) {
      files += 1;
      events.push(...readEvents(f, seen));
    }
  }
  const list = buildList(events);
  c.writeJson(FILES.list, { scanned: new Date().toISOString(), roots, artifacts: list });
  const full = withLabels(list);
  buildPage(full);
  return { roots, files, full };
}

function cached() {
  const saved = c.readJson(FILES.list, null);
  return saved ? withLabels(saved.artifacts) : scan([]).full;
}

function row(a) {
  const when = String(a.updated).slice(0, 10);
  const tags = [...a.labels, ...a.projects.map((p) => `@${p}`)].join(' ');
  return `${when}  ${a.title || '(untitled)'}${a.deleted ? '  [deleted]' : ''}\n            ${a.url}  v${a.versions}  ${tags}`;
}

function main(argv) {
  const extraRoots = [];
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') extraRoots.push(argv[++i]);
    else args.push(argv[i]);
  }
  const [cmd = 'scan', ...rest] = args;

  switch (cmd) {
    case 'scan': {
      const { roots, files, full } = scan(extraRoots);
      const live = full.filter((a) => !a.deleted);
      const unlabeled = live.filter((a) => !a.labels.length).length;
      console.log(`Scanned ${files} transcripts in: ${roots.join(', ') || '(no Claude config folders found)'}`);
      console.log(`Artifacts: ${live.length} live, ${full.length - live.length} deleted, ${unlabeled} without topic labels`);
      console.log(`Shelf page: ${FILES.page}`);
      break;
    }
    case 'unlabeled': {
      const full = scan(extraRoots).full;
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
      const n = setLabels(map);
      buildPage(cached());
      console.log(`Labelled ${n} artifact(s). Shelf page: ${FILES.page}`);
      break;
    }
    case 'find': {
      const hits = search(cached(), rest);
      console.log(hits.length ? hits.map(row).join('\n') : `No artifacts match "${rest.join(' ')}".`);
      break;
    }
    case 'open': {
      const { full } = scan(extraRoots);
      const query = rest.join(' ');
      const file = query ? buildPage(full, { file: FILES.searchPage, query }) : FILES.page;
      console.log(`Opened ${openInBrowser(file)}`);
      break;
    }
    default:
      throw new Error(`Unknown command "${cmd}". Use scan, unlabeled, label, find or open.`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
