// Artifacts: find every artifact publish/delete in the session transcripts, keep their labels,
// pins and hidden flags, and build the artifact list the shelf shows.
//
// Every artifact event ever seen is kept in events.json, so an artifact stays on the shelf after Claude Code
// cleans up its old transcript. Unchanged transcripts are skipped (scan-index.json), so a rescan is quick.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('./common');

const DATA = c.dataDir();
const FILES = {
  list: path.join(DATA, 'artifacts.json'),
  labels: path.join(DATA, 'labels.json'), // { "<artifact id>": ["label", ...] }
  meta: path.join(DATA, 'artifact-meta.json'), // { "<artifact id>": { pinned, hidden, removed } }
  events: path.join(DATA, 'events.json'),
  index: path.join(DATA, 'scan-index.json'),
  lock: path.join(DATA, 'scan.lock'),
};

// ---------- finding the config folders and transcripts ----------

function configRoots(extra = []) {
  const roots = new Set([c.configDir()]);
  const home = os.homedir();
  try {
    for (const name of fs.readdirSync(home)) {
      if (/^\.claude([-_.].+)?$/.test(name)) roots.add(path.join(home, name));
    }
  } catch {}
  for (const r of (process.env.NUDGE_ROOTS || '').split(path.delimiter)) if (r) roots.add(path.resolve(r));
  for (const r of c.config().roots || []) roots.add(path.resolve(r));
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

const INPUT_KEYS = ['action', 'file_path', 'url', 'title', 'description', 'icon', 'label', 'type_url', 'asset', 'path'];

// Keep only what the shelf needs, so events.json stays small.
function compactEvent({ id, ts, sid, cwd, launchDir, tool, input = {}, result, text }) {
  const inp = Object.fromEntries(INPUT_KEYS.filter((k) => input[k] != null).map((k) => [k, input[k]]));
  if (input.container?.create) inp.container = { create: { name: input.container.create.name || '' } };
  const r = result && typeof result === 'object' ? result : {};
  return {
    id,
    ts,
    sid,
    cwd,
    launchDir,
    tool,
    input: inp,
    result: { url: r.url || '', title: r.title || '', icon: r.icon || '' },
    textUrl: c.URL_RE.exec(text || '')?.[0] || '',
  };
}

// One event per artifact tool call that succeeded.
function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (!text.includes('claude.ai/')) return [];

  const calls = new Map(); // tool_use id -> call, waiting for its result
  const events = [];
  const launchDir = c.firstCwd(text);
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
        if (b.is_error) continue;
        events.push(compactEvent({ ...call, id: b.tool_use_id, ts: o.timestamp || call.ts, result: o.toolUseResult, text: c.asText(b.content) }));
      }
    }
  }
  return events;
}

// ---------- building the artifact list ----------

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
    const r = ev.result || {};
    const url = action === 'delete' ? ev.input.url : r.url || ev.textUrl || ev.input.url;
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
    add(a.projects, c.projectName(ev.cwd, ev.launchDir));
    add(a.cwds, ev.cwd);
    add(a.sessions, ev.sid);
    add(a.files, file);
  }
  return [...byId.values()].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

// ---------- labels, pins, hidden and removed flags ----------

const loadLabels = () => c.readJson(FILES.labels, {});
const loadMeta = () => c.readJson(FILES.meta, {});
const idOf = (s) => c.URL_RE.exec(s)?.[1] || String(s).trim();
const cleanLabels = (ls) => [...new Set((ls || []).map((l) => String(l).trim().toLowerCase().slice(0, 40)).filter(Boolean))];

// map: { "<id or url>": ["label", ...] or "a,b" }. An empty list clears that artifact's labels.
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

// Rename a label everywhere (to = '' deletes it). Returns the previous labels of every artifact it touched.
function renameLabel(from, to) {
  const [old] = cleanLabels([from]);
  const [next] = cleanLabels([to]);
  const labels = loadLabels();
  const before = {};
  for (const [id, ls] of Object.entries(labels)) {
    if (!ls.includes(old)) continue;
    before[id] = ls;
    const updated = cleanLabels(ls.flatMap((l) => (l !== old ? [l] : next ? [next] : [])));
    if (updated.length) labels[id] = updated;
    else delete labels[id];
  }
  c.writeJson(FILES.labels, labels);
  return before;
}

function setMeta(id, patch) {
  const meta = loadMeta();
  const m = { ...(meta[id] || {}) };
  for (const k of ['pinned', 'hidden', 'removed']) if (k in patch) m[k] = !!patch[k];
  if (!m.pinned && !m.hidden && !m.removed) delete meta[id];
  else meta[id] = m;
  c.writeJson(FILES.meta, meta);
}

function decorate(list) {
  const labels = loadLabels();
  const meta = loadMeta();
  // "removed" is the shelf's Delete: the artifact never shows again (claude.ai is untouched), unless it's undone.
  return list
    .filter((a) => !meta[a.id]?.removed)
    .map((a) => ({ ...a, labels: labels[a.id] || [], pinned: !!meta[a.id]?.pinned, hidden: !!meta[a.id]?.hidden }));
}

// ---------- search ----------

const haystack = (a) =>
  [a.title, a.description, a.url, a.kind, ...a.labels, ...a.projects, ...a.versionLabels].join(' ').toLowerCase();

function search(list, words) {
  const terms = words.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((a) => terms.every((t) => haystack(a).includes(t)));
}

// ---------- scanning ----------

// One scan at a time across processes (the hook, the server and the skill can all start one).
function withLock(fn) {
  fs.mkdirSync(DATA, { recursive: true });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(FILES.lock, 'wx'));
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(FILES.lock).mtimeMs > 60000) fs.rmSync(FILES.lock, { force: true }); // stale
      } catch {}
      if (Date.now() > deadline) throw new Error('Another scan is still running; try again in a moment.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(FILES.lock, { force: true });
  }
}

function scan(extraRoots = [], extraEvents = []) {
  return withLock(() => {
    const roots = configRoots(extraRoots);
    const store = c.readJson(FILES.events, {});
    const index = c.readJson(FILES.index, {});
    let files = 0;
    let read = 0;
    for (const root of roots) {
      for (const f of transcripts(path.join(root, 'projects'))) {
        files += 1;
        let st;
        try {
          st = fs.statSync(f);
        } catch {
          continue;
        }
        const key = c.normPath(f);
        if (index[key] && index[key].m === st.mtimeMs && index[key].s === st.size) continue;
        read += 1;
        for (const ev of readEvents(f)) store[ev.id] = ev; // the transcript's copy wins over a hook's copy
        index[key] = { m: st.mtimeMs, s: st.size };
      }
    }
    for (const ev of extraEvents) if (!store[ev.id]) store[ev.id] = ev;

    const generated = new Date().toISOString();
    const list = buildList(Object.values(store));
    c.writeJson(FILES.events, store);
    c.writeJson(FILES.index, index);
    c.writeJson(FILES.list, { scanned: generated, roots, artifacts: list });
    return { roots, files, read, full: decorate(list), generated };
  });
}

function cached() {
  const saved = c.readJson(FILES.list, null);
  return saved ? { full: decorate(saved.artifacts), generated: saved.scanned, roots: saved.roots || [] } : scan();
}

// PostToolUse may run before the call reaches the transcript, so the event itself is recorded too.
function recordHookEvent(event) {
  const { tool_name: tool, tool_input: input = {} } = event;
  if (!c.artifactAction(tool, input)) return null;
  let launchDir = event.cwd || '';
  try {
    const fd = fs.openSync(event.transcript_path, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    launchDir = c.firstCwd(buf.toString('utf8', 0, n)) || launchDir;
  } catch {}
  const ev = compactEvent({
    id: event.tool_use_id || `hook-${Date.now()}`,
    ts: new Date().toISOString(),
    sid: event.session_id,
    cwd: event.cwd,
    launchDir,
    tool,
    input,
    result: event.tool_response,
    text: c.asText(event.tool_response),
  });
  return scan([], [ev]);
}

module.exports = {
  configRoots,
  transcripts,
  scan,
  cached,
  search,
  setLabels,
  renameLabel,
  setMeta,
  recordHookEvent,
};
