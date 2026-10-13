// Claude Code hook: one artifact per session unless the user asks for another.
//
//   SessionStart        tells Claude the rule, so it republishes to the same artifact by default.
//   PreToolUse          asks the user before a session publishes a second NEW artifact.
//   PostToolUse         remembers which artifacts (and source files) this session published.
//   PostToolUseFailure  forgets a publish that failed, so a retry isn't treated as a second artifact.
//
// Republishing the same file, or publishing with the artifact's `url`, is always allowed: those are new versions.
// Turn the guard off with {"guard": "off"} in <claude config dir>/nudge/config.json, or NUDGE_GUARD=off.
// Any failure here falls back to letting the call through, so the hook never breaks a session.

const path = require('node:path');
const c = require('./common');

const STATE_FILE = path.join(c.dataDir(), 'guard-state.json');
const MAX_SESSIONS = 300;

const RULE = [
  'Artifact rule for this session (from the Nudge plugin):',
  '- Publish at most ONE new artifact in this session. Every later change goes to that same artifact:',
  '  republish the same file_path (or pass its url), which becomes a new version, ideally with a short `label`.',
  '- Create a separate artifact only when the user explicitly asks for a separate or new one.',
  '- If a hook asks the user to approve a second new artifact, that is this rule; do not work around it.',
].join('\n');

const guardOff = () => {
  if ((process.env.NUDGE_GUARD || '').toLowerCase() === 'off') return true;
  return c.readJson(path.join(c.dataDir(), 'config.json'), {}).guard === 'off';
};

function loadState() {
  const s = c.readJson(STATE_FILE, {});
  return { sessions: s.sessions || {} };
}

function saveState(state) {
  const ids = Object.keys(state.sessions);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete state.sessions[id];
  c.writeJson(STATE_FILE, state);
}

const sessionOf = (state, sid) =>
  state.sessions[sid] || (state.sessions[sid] = { artifacts: [], paths: [], claims: [] });

function pre(event) {
  const { tool_name: tool, tool_input: input = {}, session_id: sid } = event;
  if (!c.isNewArtifactCall(tool, input)) return null;

  const state = loadState();
  const s = sessionOf(state, sid);
  const file = input.file_path && !input.type_url ? c.normPath(input.file_path) : null;
  if (file && s.paths.includes(file)) return null; // same file republished = same artifact, new version

  const known = s.artifacts.length + s.claims.length;
  if (known) {
    const names = s.artifacts.map((a) => (a.title ? `"${a.title}" (${a.url})` : a.url));
    const already = names.length ? names.join(', ') : 'another artifact a moment ago';
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          `This session already published ${already}. By default a change should go to that artifact as a new version ` +
          '(republish the same file or pass its url). Approve only if you asked for a separate artifact.',
      },
    };
  }

  // First new artifact of the session: hold a claim so a parallel second publish is caught too.
  s.claims.push({ tool_use_id: event.tool_use_id || '', file, at: new Date().toISOString() });
  if (file) s.paths.push(file);
  saveState(state);
  return null;
}

function post(event) {
  const { tool_name: tool, tool_input: input = {}, session_id: sid } = event;
  if (c.artifactAction(tool, input) !== 'publish') return;

  const res = event.tool_response;
  const url = (typeof res === 'object' && res?.url) || c.URL_RE.exec(c.asText(res))?.[0] || input.url;
  const id = c.URL_RE.exec(url || '')?.[1];
  const state = loadState();
  const s = sessionOf(state, sid);
  s.claims = s.claims.filter((k) => k.tool_use_id !== event.tool_use_id);
  if (id) {
    const title = (typeof res === 'object' && res?.title) || input.title || input.container?.create?.name || '';
    const rec = s.artifacts.find((a) => a.id === id);
    if (rec) rec.title = title || rec.title;
    else s.artifacts.push({ id, url, title, at: new Date().toISOString() });
  }
  if (input.file_path && !input.type_url) {
    const file = c.normPath(input.file_path);
    if (!s.paths.includes(file)) s.paths.push(file);
  }
  saveState(state);
}

function failed(event) {
  const state = loadState();
  const s = state.sessions[event.session_id];
  if (!s) return;
  const claim = s.claims.find((k) => k.tool_use_id === event.tool_use_id);
  if (!claim) return;
  s.claims = s.claims.filter((k) => k !== claim);
  if (claim.file) s.paths = s.paths.filter((p) => p !== claim.file);
  saveState(state);
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    if (guardOff()) process.exit(0);
    const event = JSON.parse(raw);
    let out = null;
    switch (event.hook_event_name) {
      case 'SessionStart':
        out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: RULE } };
        break;
      case 'PreToolUse':
        out = pre(event);
        break;
      case 'PostToolUse':
        post(event);
        break;
      case 'PostToolUseFailure':
        failed(event);
        break;
    }
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    // never block a session over the guard
  }
  process.exit(0);
});
