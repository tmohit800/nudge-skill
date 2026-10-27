// Repos: the "not pushed yet" board. Finds the git repos you work in (from the folders your Claude Code
// conversations ran in, plus any listed in ~/.claude/nudge/config.json "repos"), and reports for each one, and
// each of its worktrees: the current branch, uncommitted files, stashes, and every local branch with commits
// that are on no remote. Read-only: the only git command that changes anything is an explicit Fetch, which only
// updates the local copy of the remote's branches. Nothing here commits or pushes.
// The same logic runs in Mohit's local Nudge app (D:/nudge/repos.js); keep the two in step.

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const RECENT_DAYS = 90; // conversations older than this don't add repos to the board
const MAX_BRANCHES = 40; // per repo, newest first
const CACHE_MS = 30000;

const git = (cwd, args, timeout = 20000) =>
  new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout));
  });

const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)); // Windows paths ignore case
const isRepo = (dir) => {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
};

// The repo a folder belongs to: the folder itself or its nearest parent with a .git.
function repoRoot(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 12; i++) {
    if (isRepo(d)) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

// Candidate repos: where conversations ran, the repos directly inside a launch folder that isn't a repo
// (d:\work holds api, web, ...), and config.repos. config.ignoreRepos drops some.
function discover(conversationList, config = {}) {
  const since = Date.now() - RECENT_DAYS * 86400e3;
  const dirs = new Set(config.repos || []);
  for (const m of conversationList) {
    if (m.automated || Date.parse(m.updated) < since) continue;
    for (const d of [m.cwd, m.launchDir]) if (d) dirs.add(d);
  }
  const roots = new Map();
  const add = (root) => root && !roots.has(key(root)) && roots.set(key(root), root);
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const root = repoRoot(d);
    if (root) {
      add(root);
      continue;
    }
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory() && isRepo(path.join(d, e.name))) add(path.join(d, e.name));
      }
    } catch {}
  }
  const ignore = new Set((config.ignoreRepos || []).map(key));
  return [...roots.values()].filter((r) => !ignore.has(key(r)));
}

// "## main...origin/main [ahead 1, behind 2]" plus one line per changed file.
function parseStatus(text) {
  const lines = text.split('\n').filter(Boolean);
  let head = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
  head = head.replace(/^No commits yet on /, '');
  const track = /\[(.+)\]$/.exec(head)?.[1] || '';
  const [branchName, upstreamName = ''] = head.replace(/\s*\[.+\]$/, '').split('...'); // branch names can't contain "..."
  const files = { staged: 0, modified: 0, untracked: 0, conflicts: 0 };
  const changed = [];
  for (const l of lines) {
    const x = l[0];
    const y = l[1];
    if (l.startsWith('??')) files.untracked += 1;
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) files.conflicts += 1;
    else {
      if (x !== ' ') files.staged += 1;
      if (y !== ' ') files.modified += 1;
    }
    if (changed.length < 30) changed.push(l);
  }
  return {
    branch: head.startsWith('HEAD (no branch)') ? '(detached)' : branchName,
    upstream: upstreamName,
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] || 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] || 0),
    files,
    changed,
  };
}

// worktreeOf: set for an extra worktree (it shows only its own branch; stashes belong to the main repo).
// skip: branches checked out in another worktree, which that worktree's card shows instead.
async function inspect(dir, { worktreeOf = '', skip = [] } = {}) {
  const out = { path: dir, name: path.basename(dir), worktreeOf, skip, error: '' };
  try {
    const [status, refs, stashes, commonDir] = await Promise.all([
      git(dir, ['status', '--porcelain=v1', '-b']),
      git(dir, ['for-each-ref', 'refs/heads', '--sort=-committerdate', `--count=${MAX_BRANCHES}`,
        '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(committerdate:iso-strict)']),
      git(dir, ['stash', 'list']).catch(() => ''),
      git(dir, ['rev-parse', '--git-common-dir']).catch(() => '.git'),
    ]);
    Object.assign(out, parseStatus(status));
    out.stashes = worktreeOf ? 0 : stashes.split('\n').filter(Boolean).length;
    try {
      out.lastFetch = fs.statSync(path.resolve(dir, commonDir.trim(), 'FETCH_HEAD')).mtime.toISOString();
    } catch {
      out.lastFetch = null;
    }
    out.hasRemote = !!(await git(dir, ['remote']).catch(() => '')).trim();

    // Every local branch with commits that are on no remote at all (pushed nowhere yet).
    out.branches = [];
    for (const line of refs.split('\n').filter(Boolean)) {
      const [name, upstream, track, date] = line.split('\t');
      if (worktreeOf ? name !== out.branch : skip.includes(name)) continue;
      if (!out.hasRemote) continue; // a repo with no remote at all is flagged once, below
      const count = Number((await git(dir, ['rev-list', '--count', name, '--not', '--remotes']).catch(() => '0')).trim());
      if (!count) continue; // everything on this branch is on a remote (a deleted remote branch alone is just merged work)
      const log = count
        ? await git(dir, ['log', '--format=%h%x09%s%x09%cI', '-n', '15', name, '--not', '--remotes']).catch(() => '')
        : '';
      out.branches.push({
        name,
        upstream: upstream || '',
        unpushed: count,
        gone: /gone/.test(track || ''),
        date,
        commits: log.split('\n').filter(Boolean).map((l) => {
          const [sha, subject, at] = l.split('\t');
          return { sha, subject, at };
        }),
      });
    }
    out.unpushed = out.branches.reduce((n, b) => n + (b.unpushed || 0), 0);
    const f = out.files;
    out.dirty = f.staged + f.modified + f.untracked + f.conflicts;
    out.needsAttention = out.dirty > 0 || out.unpushed > 0 || out.stashes > 0 || !out.hasRemote;
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

// Each repo plus its extra worktrees (d:\work\worktrees\...), deduplicated: [{ dir, worktreeOf, skip }].
async function withWorktrees(roots) {
  const all = new Map();
  await Promise.all(roots.map(async (r) => {
    const list = await git(r, ['worktree', 'list', '--porcelain']).catch(() => '');
    const trees = list.split(/\n\n+/).map((block) => ({
      dir: /^worktree (.+)$/m.exec(block)?.[1]?.trim(),
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() || '',
    })).filter((t) => t.dir);
    const main = trees[0] ? path.resolve(trees[0].dir) : r; // git lists the main worktree first
    if (all.has(key(main))) return;
    const extra = trees.slice(1).filter((t) => fs.existsSync(t.dir));
    all.set(key(main), { dir: main, worktreeOf: '', skip: extra.map((t) => t.branch).filter(Boolean) });
    for (const t of extra) all.set(key(t.dir), { dir: path.resolve(t.dir), worktreeOf: main, skip: [] });
  }));
  return [...all.values()];
}

let cache = { at: 0, data: null, pending: null };

async function board(conversationList, config, { refresh = false } = {}) {
  if (!refresh && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const dirs = await withWorktrees(discover(conversationList, config));
    const repos = await Promise.all(dirs.map((d) => inspect(d.dir, d)));
    repos.sort((a, b) => (b.needsAttention - a.needsAttention) || a.path.localeCompare(b.path));
    const data = { checkedAt: new Date().toISOString(), repos };
    cache = { at: Date.now(), data, pending: null };
    return data;
  })().finally(() => (cache.pending = null));
  return cache.pending;
}

// Fetch only updates the local copy of the remote's branches; it never changes your branches or files.
async function fetchRepo(dir, known) {
  const r = known.find((x) => key(x.path) === key(dir));
  if (!r) throw Object.assign(new Error('That folder is not on the board.'), { status: 404 });
  await git(r.path, ['fetch', '--all', '--quiet'], 120000);
  cache.at = 0;
  return inspect(r.path, { worktreeOf: r.worktreeOf, skip: r.skip || [] });
}

// Opens a repo on the board in VS Code, or a terminal window in it. Nothing is run in the terminal.
function openFolder(dir, target, known) {
  const r = known.find((x) => key(x.path) === key(dir));
  if (!r) throw Object.assign(new Error('That folder is not on the board.'), { status: 404 });
  const vscodeUrl = `vscode://file/${encodeURI(r.path.replace(/\\/g, '/'))}`;
  const detached = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') {
    if (/["%^&|<>]/.test(r.path)) throw new Error(`Can't open that folder from here: ${r.path}`);
    const cmdline = target === 'vscode'
      ? `/c start "" "${vscodeUrl}"`
      : `/c start "${path.basename(r.path)}" /D "${r.path}" cmd.exe /k git status -sb`;
    spawn('cmd.exe', [cmdline], { ...detached, windowsVerbatimArguments: true }).unref();
  } else if (target === 'vscode') {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [vscodeUrl], detached).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', r.path], detached).unref();
  } else {
    spawn('x-terminal-emulator', [], { ...detached, cwd: r.path }).unref();
  }
  return { opened: target === 'vscode' ? 'vscode' : 'terminal', dir: r.path };
}

const cachedAttention = () => (cache.data ? cache.data.repos.filter((r) => r.needsAttention).length : null);

module.exports = { board, fetchRepo, openFolder, cachedAttention };
