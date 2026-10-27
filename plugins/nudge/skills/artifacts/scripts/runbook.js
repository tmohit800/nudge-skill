// Runbook: commands you reuse, kept in ~/.claude/nudge/runbook.json. Copy only: nothing here runs them.
// Mohit's local Nudge app keeps the same thing in Postgres (D:/nudge, the runbook table); keep the two in step.

const crypto = require('node:crypto');
const path = require('node:path');
const c = require('./common');

const FILE = path.join(c.dataDir(), 'runbook.json');
const load = () => c.readJson(FILE, []);
const save = (list) => c.writeJson(FILE, list);
const clean = (s, max) => String(s ?? '').slice(0, max);
const fail = (status, message) => Object.assign(new Error(message), { status });

function list() {
  return load().sort((a, b) => (b.pinned - a.pinned) || a.group.localeCompare(b.group) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

function add(r) {
  const title = clean(r.title, 200).trim();
  const command = clean(r.command, 20000);
  if (!title || !command.trim()) throw fail(400, 'A title and a command are both needed.');
  const all = load();
  const item = {
    id: r.id && !all.some((x) => x.id === r.id) ? String(r.id) : crypto.randomUUID().slice(0, 8),
    title,
    command,
    notes: clean(r.notes, 2000),
    group: clean(r.group, 60).trim() || 'General',
    pinned: !!r.pinned,
    copies: Number(r.copies) || 0,
    lastCopiedAt: r.lastCopiedAt || null,
    createdAt: r.createdAt || new Date().toISOString(),
    updatedAt: r.updatedAt || null,
  };
  all.push(item);
  save(all);
  return item;
}

function update(id, patch) {
  const all = load();
  const item = all.find((x) => x.id === id);
  if (!item) throw fail(404, 'Command not found.');
  if ('title' in patch) {
    if (!String(patch.title || '').trim()) throw fail(400, 'The title can\'t be empty.');
    item.title = clean(patch.title, 200).trim();
  }
  if ('command' in patch) {
    if (!String(patch.command || '').trim()) throw fail(400, 'The command can\'t be empty.');
    item.command = clean(patch.command, 20000);
  }
  if ('notes' in patch) item.notes = clean(patch.notes, 2000);
  if ('group' in patch) item.group = clean(patch.group, 60).trim() || 'General';
  if ('pinned' in patch) item.pinned = !!patch.pinned;
  item.updatedAt = new Date().toISOString();
  save(all);
  return item;
}

function copied(id) {
  const all = load();
  const item = all.find((x) => x.id === id);
  if (!item) throw fail(404, 'Command not found.');
  item.copies += 1;
  item.lastCopiedAt = new Date().toISOString();
  save(all);
  return item;
}

// Returns the removed item, so the page can undo by adding it back.
function remove(id) {
  const all = load();
  const item = all.find((x) => x.id === id);
  if (!item) throw fail(404, 'Command not found.');
  save(all.filter((x) => x.id !== id));
  return item;
}

module.exports = { list, add, update, copied, remove };
