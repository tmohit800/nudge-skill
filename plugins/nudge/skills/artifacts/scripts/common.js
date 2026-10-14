// Shared helpers for the Nudge artifact shelf (shelf.js) and the one-artifact guard (guard.js).
// Everything Nudge stores lives in <claude config dir>/nudge, so nothing leaves the machine.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)/;
const URL_RE_ALL = new RegExp(URL_RE.source, 'g');

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const dataDir = () => path.join(configDir(), 'nudge');

// Windows paths are case-insensitive, so compare them lowercased.
const normPath = (p) => {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
};

const isArtifactTool = (name) => name === 'Artifact';
const isDocTool = (name) => /Claude_Docs__(batch|create)$/.test(name || '');

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function titleFromFile(file) {
  try {
    if (!/\.html?$/i.test(file)) return '';
    const m = /<title[^>]*>([^<]*)<\/title>/i.exec(fs.readFileSync(file, 'utf8').slice(0, 20000));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

// What a tool call does to the artifact list: 'publish' (a new artifact or a new version),
// 'delete', or null for everything else (read, list, open, asset uploads, doc edits...).
function artifactAction(toolName, input = {}) {
  if (isArtifactTool(toolName)) {
    const action = input.action || 'publish';
    if (action === 'delete') return input.path ? null : 'delete'; // with `path` it removes one asset only
    if (action !== 'publish' || input.asset) return null;
    return 'publish';
  }
  if (isDocTool(toolName)) {
    if (/__create$/.test(toolName) || input.container?.create) return 'publish';
  }
  return null;
}

// The folder a transcript's session was started in: the first `cwd` it records.
function firstCwd(text) {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text);
  try {
    return m ? JSON.parse(`"${m[1]}"`) : '';
  } catch {
    return '';
  }
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

// <claude config dir>/nudge/config.json: { guard: "off", port: 4783, roots: [...], chat: false }
const config = () => readJson(path.join(dataDir(), 'config.json'), {});

// A publish that can only produce a brand-new artifact (no `url` to update).
function isNewArtifactCall(toolName, input = {}) {
  if (artifactAction(toolName, input) !== 'publish') return false;
  if (isDocTool(toolName)) return true;
  return !input.url;
}

module.exports = {
  URL_RE,
  URL_RE_ALL,
  configDir,
  dataDir,
  normPath,
  isArtifactTool,
  isDocTool,
  asText,
  readJson,
  writeJson,
  titleFromFile,
  firstCwd,
  projectName,
  config,
  artifactAction,
  isNewArtifactCall,
};
