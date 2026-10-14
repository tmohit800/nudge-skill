// Conversations: index every Claude Code session transcript in every Claude config folder, search them,
// show one, and open it in Claude Code (a new terminal window, or a Claude Code tab in VS Code).
//
// The transcript format is internal to Claude Code and can change between releases, so every reader here is
// defensive: unknown lines are skipped, and a session that can't be read just shows less.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const c = require('./common');
const { configRoots, transcripts } = require('./artifacts');

const DATA = c.dataDir();
const FILES = {
  index: path.join(DATA, 'conversations.json'), // { "<file key>": { m, s, meta } }
  text: path.join(DATA, 'conversation-text.json'), // { "<session id>": "searchable text" }
};
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTOMATED = /^sdk/; // `claude -p` and Agent SDK runs: background jobs, not chats
const TEXT_PER_MESSAGE = 2000;
const TEXT_PER_SESSION = 200000;

// ---------- reading one transcript ----------

// The text of a user turn the person typed, or '' for tool results, hook output and other machinery.
function promptText(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return '';
  const content = o.message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) && !content.some((b) => b.type === 'tool_result')
      ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  if (!text) return '';
  const cmd = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/.exec(text);
  if (cmd) return `${cmd[1]} ${cmd[2] || ''}`.trim();
  if (/^\s*<(local-command|system-reminder|task-notification|bash-|user-memory)/.test(text) || /^Caveat: /.test(text)) return '';
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

const assistantText = (o) =>
  o.type === 'assistant' && !o.isSidechain && Array.isArray(o.message?.content)
    ? o.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() : '';

function readSession(file, root) {
  const text = fs.readFileSync(file, 'utf8');
  const meta = {
    id: path.basename(file, '.jsonl'),
    file,
    root,
    launchDir: c.firstCwd(text),
    cwd: '',
    gitBranch: '',
    entrypoint: '',
    title: '',
    aiTitle: '',
    firstPrompt: '',
    lastPrompt: '',
    created: '',
    updated: '',
    prompts: 0,
    replies: 0,
    model: '',
  };
  let corpus = '';
  const addText = (t) => {
    if (corpus.length < TEXT_PER_SESSION) corpus += `${t.slice(0, TEXT_PER_MESSAGE)}\n`;
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'custom-title' && o.customTitle) meta.title = o.customTitle;
    else if (o.type === 'ai-title' && o.aiTitle) meta.aiTitle = o.aiTitle;
    if (!o.timestamp) continue;
    if (!meta.created) meta.created = o.timestamp;
    meta.updated = o.timestamp;
    if (o.cwd) meta.cwd = o.cwd;
    if (o.gitBranch && o.gitBranch !== 'HEAD') meta.gitBranch = o.gitBranch;
    if (o.entrypoint && !meta.entrypoint) meta.entrypoint = o.entrypoint;
    const p = promptText(o);
    if (p) {
      meta.prompts += 1;
      if (!meta.firstPrompt) meta.firstPrompt = p.slice(0, 400);
      meta.lastPrompt = p.slice(0, 400);
      addText(p);
    }
    const a = assistantText(o);
    if (a) {
      meta.replies += 1;
      addText(a);
    }
    if (o.type === 'assistant' && o.message?.model && !o.isSidechain) meta.model = o.message.model;
  }
  meta.title = meta.title || meta.aiTitle || meta.firstPrompt.split('\n')[0].slice(0, 120) || 'Untitled conversation';
  meta.automated = AUTOMATED.test(meta.entrypoint);
  meta.project = c.projectName(meta.cwd || meta.launchDir, meta.launchDir);
  delete meta.aiTitle;
  return { meta, corpus };
}

// ---------- the index ----------

let memo = null; // { list, raw: Map<id, text>, text: Map<id, lowercased text> }, kept by the server between requests

function sync() {
  const index = c.readJson(FILES.index, {});
  const texts = c.readJson(FILES.text, {});
  const seen = new Set();
  let read = 0;
  for (const root of configRoots()) {
    for (const f of transcripts(path.join(root, 'projects'))) {
      if (f.split(/[\\/]/).includes('subagents')) continue;
      if (!SESSION_RE.test(path.basename(f, '.jsonl'))) continue;
      const key = c.normPath(f);
      seen.add(key);
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (index[key] && index[key].m === st.mtimeMs && index[key].s === st.size) continue;
      try {
        const { meta, corpus } = readSession(f, root);
        if (!meta.created) continue; // nothing but bookkeeping lines
        meta.bytes = st.size;
        index[key] = { m: st.mtimeMs, s: st.size, meta };
        texts[meta.id] = corpus;
        read += 1;
      } catch {}
    }
  }
  // A transcript Claude Code cleaned up can't be opened or resumed any more, so it leaves the list.
  for (const key of Object.keys(index)) {
    if (!seen.has(key)) {
      delete texts[index[key].meta?.id];
      delete index[key];
    }
  }
  c.writeJson(FILES.index, index);
  c.writeJson(FILES.text, texts);
  memo = null;
  return { read, total: Object.keys(index).length };
}

function load() {
  if (memo) return memo;
  let index = c.readJson(FILES.index, null);
  if (!index) {
    sync();
    index = c.readJson(FILES.index, {});
  }
  const texts = c.readJson(FILES.text, {});
  const all = Object.values(index).map((e) => e.meta).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const raw = new Map(all.map((m) => [m.id, `${m.title}\n${texts[m.id] || ''}`]));
  memo = { list: all, raw, text: new Map([...raw].map(([id, t]) => [id, t.toLowerCase()])) };
  return memo;
}

const byId = (id) => load().list.find((m) => m.id === id);

// A short piece of text around the first match, for the result list.
function snippet(meta, terms) {
  const { text, raw } = load();
  const hay = text.get(meta.id) || '';
  const hits = terms.map((t) => hay.indexOf(t)).filter((i) => i >= 0);
  if (!hits.length) return '';
  const at = Math.min(...hits);
  const start = Math.max(0, at - 70);
  return (start ? '…' : '') + (raw.get(meta.id) || hay).slice(start, at + 160).replace(/\s+/g, ' ').trim() + '…';
}

// q: words that must all appear (title, prompts, replies, project, branch). Returns newest first.
function list({ q = '', project = '', automated = false, limit = 300 } = {}) {
  const { list: all, text } = load();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  let automatedCount = 0;
  const projects = {};
  for (const m of all) {
    if (m.automated) automatedCount += 1;
    if (m.automated && !automated) continue;
    projects[m.project] = (projects[m.project] || 0) + 1;
    if (project && m.project !== project) continue;
    if (terms.length) {
      const hay = `${text.get(m.id) || ''} ${m.project} ${m.gitBranch}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
    }
    out.push(terms.length ? { ...m, snippet: snippet(m, terms) } : m);
  }
  return {
    total: all.length,
    automated: automatedCount,
    matches: out.length,
    projects,
    conversations: out.slice(0, limit).map(({ file, ...m }) => m),
  };
}

// ---------- one conversation's messages ----------

const TOOL_HINT = ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'prompt', 'path'];
function toolSummary(b) {
  const input = b.input || {};
  const key = TOOL_HINT.find((k) => typeof input[k] === 'string' && input[k]);
  return key ? input[key].split('\n')[0].slice(0, 160) : '';
}

const messageCache = new Map(); // file -> { m, items }, the last few conversations opened

function messages(id, { before, limit = 120 } = {}) {
  const meta = byId(id);
  if (!meta) throw Object.assign(new Error('Conversation not found. Try Sync.'), { status: 404 });
  const st = fs.statSync(meta.file);
  let entry = messageCache.get(meta.file);
  if (!entry || entry.m !== st.mtimeMs) {
    const items = [];
    for (const line of fs.readFileSync(meta.file, 'utf8').split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.isSidechain) continue;
      const p = promptText(o);
      if (p) items.push({ role: 'user', text: p, ts: o.timestamp });
      if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        for (const b of o.message.content) {
          if (b.type === 'text' && b.text.trim()) items.push({ role: 'assistant', text: b.text, ts: o.timestamp });
          else if (b.type === 'tool_use') items.push({ role: 'tool', name: b.name, text: toolSummary(b), ts: o.timestamp });
        }
      }
    }
    entry = { m: st.mtimeMs, items };
    messageCache.set(meta.file, entry);
    if (messageCache.size > 4) messageCache.delete(messageCache.keys().next().value);
  }
  const end = Number.isInteger(before) ? Math.max(0, Math.min(before, entry.items.length)) : entry.items.length;
  const start = Math.max(0, end - limit);
  const { file, ...pub } = meta;
  return {
    meta: { ...pub, activeRecently: Date.now() - st.mtimeMs < 120000, resumeCommand: resumeCommand(meta) },
    start,
    total: entry.items.length,
    items: entry.items.slice(start, end),
  };
}

// ---------- opening a conversation in Claude Code ----------

const isDefaultRoot = (root) => c.normPath(root) === c.normPath(path.join(os.homedir(), '.claude'));

function sessionEnv(meta) {
  const env = { ...process.env };
  if (isDefaultRoot(meta.root) && !process.env.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = meta.root;
  return env;
}

function workDir(meta) {
  for (const d of [meta.launchDir, meta.cwd]) {
    try {
      if (d && fs.statSync(d).isDirectory()) return d;
    } catch {}
  }
  return os.homedir(); // `claude --resume <id>` finds the session from any folder
}

// What to paste into a terminal to pick the conversation up by hand.
function resumeCommand(meta) {
  const dir = workDir(meta);
  const win = process.platform === 'win32';
  const cd = win ? `cd /d "${dir}"` : `cd '${dir.replace(/'/g, `'\\''`)}'`;
  const env = isDefaultRoot(meta.root) ? '' : win ? `set "CLAUDE_CONFIG_DIR=${meta.root}" && ` : `CLAUDE_CONFIG_DIR='${meta.root}' `;
  return `${cd} && ${env}claude --resume ${meta.id}`;
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function openUrl(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', [`/c start "" "${url.replace(/[&^"]/g, (ch) => `^${ch}`)}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// target 'terminal': a new terminal window running `claude --resume <id>`, where you carry on as usual.
// target 'vscode': opens the project folder in VS Code, then the conversation in a Claude Code tab.
function open(id, target) {
  const meta = byId(id);
  if (!meta || !SESSION_RE.test(meta.id)) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  const dir = workDir(meta);

  if (target === 'vscode') {
    openUrl(`vscode://file/${encodeURI(dir.replace(/\\/g, '/'))}`);
    // The extension only resumes a session that belongs to the open folder, so give the window a moment to open.
    setTimeout(() => openUrl(`vscode://anthropic.claude-code/open?session=${meta.id}`), 2500);
    return { opened: 'vscode', dir };
  }
  const env = sessionEnv(meta);
  if (process.platform === 'win32') {
    if (/["%^&|<>]/.test(dir)) throw new Error(`Can't open a terminal in that folder. Run: ${resumeCommand(meta)}`);
    const cmdline = `/c start "Claude Code" /D "${dir}" cmd.exe /k claude --resume ${meta.id}`;
    spawn('cmd.exe', [cmdline], { env, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    const prefix = env.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${shQuote(env.CLAUDE_CONFIG_DIR)} ` : '';
    const sh = `cd ${shQuote(dir)} && ${prefix}claude --resume ${meta.id}`;
    spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(sh)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const sh = `cd ${shQuote(dir)} && claude --resume ${meta.id}; exec "\${SHELL:-sh}"`;
    spawn('x-terminal-emulator', ['-e', 'sh', '-c', sh], { env, detached: true, stdio: 'ignore' }).unref();
  }
  return { opened: 'terminal', dir };
}

module.exports = { sync, list, messages, open };
